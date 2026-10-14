import { withFlowProcessRuntime } from "./process-runtime-admission.js";
import { captureFinalizationProcessAuthority } from "./finalization-process-authority.js";
/**
 * src/flow/lib/run-finalize-cleanup.js
 *
 * finalize-cleanup removes the selected worktree and feature branch, then
 * records completion in the shared base-side spec directory. The dispatcher
 * closes the runtime log and creates the target-spec + docs completion commit
 * after this command returns; only then is the active entry cleared.
 *
 * Recovery paths:
 *  - --auto-rescue: cherry-pick orphan commits onto baseBranch on the main
 *    repo, with detached-worktree fallback when baseBranch is locked, and
 *    `cherry-pick --skip` for empty-patch (duplicate) cases. Conflicts trigger
 *    `cherry-pick --abort` and CHERRY_PICK_CONFLICT halt.
 *  - --force: emit FORCED_ORPHAN_DROP warning, persist the dropped commit list
 *    to issue-log, then proceed to teardown.
 */

import fs from "fs";
import { isDeepStrictEqual } from "node:util";
import path from "path";
import { TemporaryPaths } from "../../lib/temporary-paths.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { getPorcelainV2Status, runGit, GitRefObservation, GitRefProbeError } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { StepPersistenceFailure, rethrowOriginalStepPersistenceFailure } from "./definition-lifecycle-failure.js";
import {
  finalizationStepRegistration,
  prepareFinalizationExecution,
  consumeFinalizationExecution,
  executeFinalizationCommand,
} from "../engine/composition/finalization.js";
import { flowStepExecutionRegistration } from "../engine/composition/registered-step-execution.js";
import {
  commitFinalizeCompletion,
  writeLastFinalizedPointer,
} from "./run-finalize.js";
import { CanonicalLatestReport } from "./run-report-show.js";
import { flattenSteps } from "./step-tree.js";
import { FinalizeCleanupStateResolution } from "./finalize-cleanup-state.js";
import { FinalizeFlowStateOwner } from "./finalize-flow-state-owner.js";
import { IssueLogDocument } from "./issue-log-store.js";
import { issueLogStoreForVersion } from "./set-issue-log.js";
import {
  CanonicalFlowArtifactWrite,
  CurrentFlowStateValidator,
  CurrentFlowVersionStore,
} from "./current-flow-state.js";
import { buildCurrentFlowDefinition, DraftStepSettlementReceipt } from "../definition.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { discoverFlowCommandHooks, runFlowCommandHooks } from "../../lib/plugin-registry.js";
import { SharedFinalizeCleanupJournal, FinalizeTeardownAuthorization, finalizeAuditId, assertExactObjectKeys, pathExistsStrict, assertPointerReality, validateTeardown, FinalizeCleanupEffectPreparation, FinalizeRescuedCommits, AutoRescueAbortFailure, AutoRescueOutcome, AutoRescueWorktreeAuthority, AutoRescueCleanupJournal, AutoRescueCleanupStore, autoRescueIdentity, autoRescueTemporaryDirectory } from "./finalize-cleanup-journal.js";
export { validateTeardown };
import { PRODUCT } from "../../lib/product.js";
import {
  FlowOutboxStore,
  finalizationOutboxIdentity,
} from "./flow-outbox.js";
import { FlowCompletion } from "./flow-completion.js";
import {
  RepositoryFlowOperationLock,
  resolveRepositoryLockRoot,
} from "../../lib/repository-maintenance-lock.js";
import {
  WorktreeFlowBindingStore,
  WorktreeFlowIdentity,
} from "../../lib/worktree-flow-binding.js";
import {
  DEFAULT_FLOW_SPEC_DIR,
  FlowSpecRoot,
  FlowWorkspace,
  flowStateSpecLocation,
} from "../../lib/flow-workspace.js";
import { FlowVersion } from "../../lib/flow-version.js";
import { FlowManager } from "../../lib/flow-manager.js";
import { deleteRepairBaselineForFlow } from "./repair-state-identity.js";
import { FlowRepositoryRuntimeArtifactRegistry } from "./flow-repository-runtime-artifacts.js";
import { recordFinalizeCleanupPostCommandMetadata } from "./finalize-cleanup-metadata.js";
export { recordFinalizeCleanupPostCommandMetadata };

const ORPHAN_COMMIT_LIST_LIMIT = 50;
const SUBMODULE_DIAGNOSTIC_LIMIT = 50;
const SUBMODULE_ERROR_TEXT_LIMIT = 1000;
const RECOVERY_OPTIONS_DETECT = ["cherry-pick", "abort", "force-continue"];
const RECOVERY_OPTIONS_BASELINE = ["archive-and-manual-cherry-pick", "force-continue"];
const RECOVERY_OPTIONS_RESCUE_FAIL = ["archive-and-manual-cherry-pick", "retry-without-rescue"];
const RECOVERY_OPTIONS_DIRTY = ["commit-or-stash-first", "retry-without-rescue"];
const SUBMODULE_RECOVERY_OPTIONS_DIRTY = ["commit-or-stash-first", "clean-submodules-and-retry", "manual-remove-after-review"];
const SUBMODULE_RECOVERY_OPTIONS_STATUS = ["inspect-status-manually", "clean-submodules-and-retry", "manual-remove-after-review"];
const SUBMODULE_RECOVERY_OPTIONS_FORCE = ["inspect-worktree-manually", "manual-remove-after-review", "retry-after-fixing-git-error"];
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function requiredSpecLocation(state) {
  const location = flowStateSpecLocation(state);
  if (!location) throw new Error("finalize cleanup spec location is unavailable");
  return location;
}

function canonicalFlowLocation(repositoryRoot, specRoot, specId) {
  return new FlowWorkspace({
    repositoryRoot,
    executionRoot: repositoryRoot,
    specRoot,
  }).canonicalVersion(specId, new FlowVersion(1));
}

function gitValue(root, args, label) {
  const result = runGit(["-C", root, ...args]);
  if (!result.ok) {
    throw new Error(`${label} could not be resolved: ${result.stderr || result.stdout || "unknown git error"}`);
  }
  return result.stdout.trim();
}

function gitFailure(code, message, result) {
  const error = new Error(`${message}: ${result.stderr || result.stdout || "unknown git error"}`);
  error.code = code;
  return error;
}

function assertInitialFinalizeGitAuthority({ targetRoot, state, worktreePath = null }) {
  const resolvedTargetRoot = fs.realpathSync(targetRoot);
  assertObservableFinalizeGitStatus(resolvedTargetRoot);
  const headRef = gitValue(resolvedTargetRoot, ["symbolic-ref", "-q", "HEAD"], "finalize HEAD ref");
  const head = gitValue(resolvedTargetRoot, ["rev-parse", "HEAD"], "finalize parent");
  const baseRef = gitValue(resolvedTargetRoot, ["rev-parse", state.baseBranch], "finalize base ref");
  gitValue(resolvedTargetRoot, ["rev-parse", state.featureBranch], "finalize feature ref");
  if (headRef !== `refs/heads/${state.baseBranch}`) {
    throw new Error(`finalize HEAD must be the configured base branch: ${state.baseBranch}`);
  }
  if (head !== baseRef) throw new Error("finalize HEAD parent must equal the configured base ref");
  if (worktreePath != null) {
    const resolvedWorktreePath = fs.realpathSync(worktreePath);
    gitValue(resolvedWorktreePath, ["rev-parse", "HEAD"], "finalize worktree HEAD");
  }
}

function assertObservableFinalizeGitStatus(root) {
  try { getPorcelainV2Status(root); }
  catch (error) {
    const refusal = new StepAdmissionRefusal(error.message, error);
    refusal.code = error.code;
    throw refusal;
  }
}

function buildReportField(mainRoot, specRoot, specId) {
  // The embedded cleanup report is the same report-show text generated from
  // validated v2 test-execute-result/test-result-review artifacts, including
  // projectRegression data. Missing or malformed report data is surfaced as
  // REPORT_MISSING instead of fabricated.
  try {
    const report = CanonicalLatestReport.read({ mainRoot, specRoot, consumerNodeId: "finalize-cleanup", explicitSpecId: specId });
    return { report: { path: report.path, text: report.text() }, missing: null };
  } catch (err) {
    return { report: null, missing: err };
  }
}

function attachReport(env, mainRoot, specRoot, specId) {
  const { report, missing } = buildReportField(mainRoot, specRoot, specId);
  env.data.report = report;
  if (missing) {
    env.addWarning("REPORT_MISSING", missing.message);
  }
  return env;
}

class AutoRescueIssueLogAllowance {
  constructor({ mainRepoPath, specRoot, specId, idempotencyKey }) {
    this.mainRepoPath = mainRepoPath;
    this.location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
    this.relativePath = this.location.relativeIssueLogFile;
    this.idempotencyKey = idempotencyKey;
  }

  allowsCurrentDocument() {
    if (typeof this.idempotencyKey !== "string" || this.idempotencyKey === "") return false;
    let current;
    try {
      current = issueLogStoreForVersion(this.location).read().document;
    } catch {
      return false;
    }
    const ownedEntries = current.entries.filter((entry) => (
      entry?.issueLogId === this.idempotencyKey || entry?.grantId === this.idempotencyKey
    ));
    if (ownedEntries.length !== 1) return false;
    current = new IssueLogDocument({
      entries: current.entries.filter((entry) => (
        entry?.issueLogId !== this.idempotencyKey && entry?.grantId !== this.idempotencyKey
      )),
    });

    const exists = runGit([
      "-C", this.mainRepoPath, "ls-tree", "--name-only", "--full-tree", "HEAD", "--", this.relativePath,
    ]);
    let committed;
    if (!exists.ok) return false;
    const committedPath = exists.stdout.trim();
    if (committedPath === this.relativePath) {
      const show = runGit(["-C", this.mainRepoPath, "show", `HEAD:${this.relativePath}`]);
      if (!show.ok) return false;
      try {
        committed = new IssueLogDocument(JSON.parse(show.stdout));
      } catch {
        return false;
      }
    } else if (committedPath === "") {
      committed = new IssueLogDocument({ entries: [] });
    } else {
      return false;
    }
    return JSON.stringify(current.toJSON()) === JSON.stringify(committed.toJSON());
  }
}

class FinalizeFlowMetadataAllowance {
  constructor({ mainRepoPath, specRoot, specId, issueLogAllowance }) {
    this.mainRepoPath = mainRepoPath;
    this.specId = specId;
    this.issueLogAllowance = issueLogAllowance;
    this.location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
    this.versionStore = new CurrentFlowVersionStore({
      location: this.location,
      definition: buildCurrentFlowDefinition(),
    });
    this.outboxStore = new FlowOutboxStore(new FlowManager({
      root: mainRepoPath, mainRoot: mainRepoPath, inWorktree: false, specRoot, specId,
    }), { specId });
  }

  allowsCurrentFlowMetadata() {
    try {
      const snapshot = this.versionStore.loadSnapshot();
      if (snapshot === null || snapshot.state.specId !== this.specId
        || snapshot.state.current?.at(-1) !== "finalize-cleanup" || snapshot.state.attempt === null) return false;
      const { state, activities } = snapshot;
      const selected = activities.findLast((activity) => activity.nodeId === "finalize-cleanup"
        && activity.attemptId === state.attempt.id && activity.sequence === state.attempt.sequence
        && activity.result?.stepResult?.kind === "finalize-cleanup-execution-required");
      if (selected === undefined) return false;
      const result = selected.result.stepResult;
      const receipt = selected.result.draftSettlementReceipt;
      const execution = result.execution;
      DraftStepSettlementReceipt.assertStored(receipt, { result, binding: {
        runId: state.runId, specId: state.specId, stepId: "finalize-cleanup", attempt: state.attempt,
      } });
      if (receipt.settlementKind !== "execution" || execution.identity.runId !== state.runId
        || execution.identity.specId !== state.specId || execution.identity.attempt.id !== state.attempt.id
        || execution.identity.attempt.sequence !== state.attempt.sequence) return false;
      const outbox = this.outboxStore.status(execution.outboxIdentity);
      if (outbox?.status !== "pending" || execution.claim?.attempt !== outbox.attempt
        || execution.claim?.idempotencyKey !== outbox.idempotencyKey) return false;

      const committedState = new CurrentFlowStateValidator({ definition: buildCurrentFlowDefinition() })
        .validate(this.committedDocument(this.location.relativeFlowStateFile));
      const committedActivities = this.committedText(this.location.relativeActivitiesFile).trimEnd().split("\n")
        .map((line) => JSON.parse(line));
      if (committedState.runId !== state.runId || committedState.specId !== state.specId
        || committedState.attempt?.id !== state.attempt.id || committedState.attempt?.sequence !== state.attempt.sequence
        || committedActivities.length !== committedState.confirmationOrder
        || !isDeepStrictEqual(activities.slice(0, committedActivities.length).map((entry) => entry.toJSON()), committedActivities)) return false;
      const suffix = activities.slice(committedActivities.length);
      const currentCatalog = this.versionStore.catalog().toJSON();
      const issueLogProducerId = this.issueLogAllowance.allowsCurrentDocument()
        ? currentCatalog.artifacts.find((entry) => entry.logicalKey === "issue.log")?.activityId
        : null;
      const ownedAudit = suffix.find((activity) => activity.id === issueLogProducerId
        && activity.transition.operation === "publish_artifacts"
        && activity.nodeId === "finalize-cleanup" && activity.attemptId === state.attempt.id
        && activity.sequence === state.attempt.sequence);
      if (suffix.length === 0 || !suffix.every((activity) => {
        if (activity.transition.operation === "begin_outbox") {
          const claimed = activity.transition.outbox;
          return activity.nodeId === state.root.id && claimed?.id === outbox.idempotencyKey
            && claimed.operation === outbox.identity.operation && claimed.attempt === outbox.attempt;
        }
        if (activity.id === ownedAudit?.id) return true;
        return activity.transition.operation === "record_draft_step_settlement"
          && activity.nodeId === "finalize-cleanup" && activity.attemptId === state.attempt.id
          && activity.sequence === state.attempt.sequence
          && activity.result?.draftSettlementReceipt?.id === receipt.id;
      })) return false;
      const committedCatalog = this.committedDocument(this.location.relativeCatalogFile);
      const retainedDescriptors = (catalog) => catalog.artifacts
        .filter((entry) => !["flow.state", "flow.activities", ...(ownedAudit === undefined ? [] : ["issue.log"])].includes(entry.logicalKey));
      return isDeepStrictEqual(retainedDescriptors(currentCatalog), retainedDescriptors(committedCatalog));
    } catch {
      return false;
    }
  }

  committedText(relativePath) {
    const result = runGit(["-C", this.mainRepoPath, "show", `HEAD:${relativePath}`]);
    if (!result.ok) throw new Error(`Committed finalize metadata is unavailable: ${relativePath}`);
    return result.stdout;
  }

  committedDocument(relativePath) { return JSON.parse(this.committedText(relativePath)); }

}

/**
 * R14: a retry may ignore only the exact stable-ID audit mutation produced by
 * its prior CHERRY_PICK_CONFLICT halt. Any other issue-log edit remains dirty.
 */
function listMainRepoDirtyFiles(
  mainRepoPath,
  specId,
  allowedIssueLogId = null,
  { allowFinalizeMetadata = false, specRoot = DEFAULT_FLOW_SPEC_DIR } = {},
) {
  const location = canonicalFlowLocation(mainRepoPath, specRoot, specId);
  const issueLogPath = location.relativeIssueLogFile;
  const flowPaths = [
    location.relativeFlowStateFile,
    location.relativeActivitiesFile,
    location.relativeCatalogFile,
  ];
  const res = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--",
    ".",
    ...new FlowRepositoryRuntimeArtifactRegistry().gitPathspecExcludes(),
    `:!${issueLogPath}`,
    ...flowPaths.map((flowPath) => `:!${flowPath}`),
  ]);
  if (!res.ok) {
    const error = new Error(`main repository status probe failed: ${res.stderr || res.stdout || "unknown Git error"}`);
    error.code = "MAIN_REPO_STATUS_FAILED";
    throw error;
  }
  const dirtyFiles = res.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
  const issueLogAllowance = new AutoRescueIssueLogAllowance({
    mainRepoPath, specRoot, specId, idempotencyKey: allowedIssueLogId,
  });
  const metadataAllowance = allowFinalizeMetadata
    ? new FinalizeFlowMetadataAllowance({ mainRepoPath, specRoot, specId, issueLogAllowance })
    : null;
  const ownedFlowMetadata = metadataAllowance?.allowsCurrentFlowMetadata() ?? false;
  for (const flowPath of flowPaths) {
    const flowStatus = runGit([
      "-C",
      mainRepoPath,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      flowPath,
    ]);
    if (!flowStatus.ok) {
      const error = new Error(`main repository Flow metadata status probe failed: ${flowStatus.stderr || flowStatus.stdout || "unknown Git error"}`);
      error.code = "MAIN_REPO_STATUS_FAILED";
      throw error;
    }
    if (flowStatus.stdout.trim() && !ownedFlowMetadata) {
      dirtyFiles.push(flowPath);
    }
  }
  const issueStatus = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    issueLogPath,
  ]);
  if (!issueStatus.ok) {
    const error = new Error(`main repository issue-log status probe failed: ${issueStatus.stderr || issueStatus.stdout || "unknown Git error"}`);
    error.code = "MAIN_REPO_STATUS_FAILED";
    throw error;
  }
  if (issueStatus.stdout.trim()) {
    if (!issueLogAllowance.allowsCurrentDocument()) {
      dirtyFiles.push(issueLogPath);
    }
  }
  return dirtyFiles;
}

function listOtherDirtyFlowJsonPaths(mainRepoPath, specRoot, specId) {
  const normalizedSpecRoot = FlowSpecRoot.from(specRoot).toString();
  const version = new FlowVersion(1);
  const stateArtifact = FLOW_ARTIFACT_CONTRACTS.resolve("flow.state").relativePath;
  const res = runGit([
    "-C",
    mainRepoPath,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    `:(glob)${normalizedSpecRoot}/*/${version.pathSegment}/${stateArtifact}`,
  ]);
  if (!res.ok) {
    throw new Error(res.stderr || res.stdout || "git status failed");
  }
  const targetPath = canonicalFlowLocation(mainRepoPath, normalizedSpecRoot, specId).relativeFlowStateFile;
  const paths = [];
  const seen = new Set();
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const relPath = line.slice(3).trim();
    if (!relPath || relPath === targetPath || seen.has(relPath)) continue;
    seen.add(relPath);
    paths.push(relPath);
  }
  return paths;
}

function attachOtherFlowMetadataWarning(env, mainRepoPath, specRoot, specId) {
  let paths;
  try {
    paths = listOtherDirtyFlowJsonPaths(mainRepoPath, specRoot, specId);
  } catch (err) {
    env.addWarning(
      "OTHER_FLOW_METADATA_STATUS_FAILED",
      `Failed to inspect other flow metadata dirtiness: ${err.message}`,
    );
    return env;
  }
  if (paths.length === 0) return env;
  env.addWarning(
    "OTHER_FLOW_METADATA_DIRTY",
    [
      "Other active flow metadata remains dirty in the main repository:",
      ...paths.map((p) => `  - ${p}`),
    ],
  );
  return env;
}

function boundedEntries(entries, limit = SUBMODULE_DIAGNOSTIC_LIMIT) {
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

function boundedText(text, limit = SUBMODULE_ERROR_TEXT_LIMIT) {
  const s = String(text || "");
  return {
    text: s.length > limit ? s.slice(0, limit) : s,
    truncated: s.length > limit,
  };
}

function parsePorcelainPaths(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function statusFailure(scope, targetPath, res) {
  const stderr = boundedText(res.stderr || "");
  const stdout = boundedText(res.stdout || "");
  return {
    failure: {
      scope,
      path: targetPath,
      stderr: stderr.text,
      stdout: stdout.text,
    },
    truncated: stderr.truncated || stdout.truncated,
  };
}

function isSubmoduleWorktreeRemoveFailure(res) {
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  return /working trees containing submodules cannot be moved or removed/i.test(text);
}

function listInitializedSubmodules(worktreePath, runGitFn = runGit) {
  const res = runGitFn(["-C", worktreePath, "submodule", "status"]);
  if (!res.ok) {
    const failure = statusFailure("submodule-list", worktreePath, res);
    return { ok: false, statusFailures: [failure.failure], truncated: failure.truncated };
  }
  const paths = res.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line[0] !== "-")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  return { ok: true, paths };
}

function inspectSubmoduleWorktreeCleanliness(worktreePath, runGitFn = runGit) {
  let truncated = false;
  const rootStatus = runGitFn(["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  if (!rootStatus.ok) {
    const failure = statusFailure("worktree", worktreePath, rootStatus);
    return { ok: false, statusFailures: [failure.failure], truncated: failure.truncated };
  }

  const root = boundedEntries(parsePorcelainPaths(rootStatus.stdout));
  truncated = truncated || root.truncated;

  const submodules = listInitializedSubmodules(worktreePath, runGitFn);
  if (!submodules.ok) return submodules;

  const dirtySubmodules = [];
  const statusFailures = [];
  for (const submodulePath of submodules.paths) {
    const absPath = path.join(worktreePath, submodulePath);
    const res = runGitFn(["-C", absPath, "status", "--porcelain", "--untracked-files=all"]);
    if (!res.ok) {
      const failure = statusFailure("submodule", submodulePath, res);
      statusFailures.push(failure.failure);
      truncated = truncated || failure.truncated;
      continue;
    }
    const dirtyFiles = boundedEntries(parsePorcelainPaths(res.stdout));
    truncated = truncated || dirtyFiles.truncated;
    if (dirtyFiles.entries.length > 0) {
      dirtySubmodules.push({ path: submodulePath, dirtyFiles: dirtyFiles.entries });
    }
  }

  const failures = boundedEntries(statusFailures);
  truncated = truncated || failures.truncated;
  if (failures.entries.length > 0) {
    return { ok: false, statusFailures: failures.entries, truncated };
  }

  const dirtyModules = boundedEntries(dirtySubmodules);
  return {
    ok: true,
    dirtyRootFiles: root.entries,
    dirtySubmodules: dirtyModules.entries,
    dirty: root.entries.length > 0 || dirtyModules.entries.length > 0,
    truncated: truncated || dirtyModules.truncated,
  };
}

function worktreeDirtyEnvelope({ worktreePath, featureBranch, inspection }) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_DIRTY",
    [
      "Worktree cleanup stopped because the worktree or an initialized submodule is dirty.",
      "Commit, stash, or remove the dirty changes, then retry finalize-cleanup.",
      "The worktree and feature branch were retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      dirtyRootFiles: inspection.dirtyRootFiles,
      dirtySubmodules: inspection.dirtySubmodules,
      truncated: inspection.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_DIRTY,
    },
  );
}

function worktreeStatusFailedEnvelope({ worktreePath, featureBranch, inspection }) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_STATUS_FAILED",
    [
      "Worktree cleanup stopped because cleanliness could not be confirmed.",
      "Inspect the reported git status failure, clean the worktree or submodules, then retry finalize-cleanup.",
      "The worktree and feature branch were retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      statusFailures: inspection.statusFailures,
      truncated: inspection.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_STATUS,
    },
  );
}

function worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res }) {
  const stderr = boundedText(res.stderr || "");
  const stdout = boundedText(res.stdout || "");
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "WORKTREE_FORCE_REMOVE_FAILED",
    [
      "Worktree cleanup stopped because clean-confirmed force removal failed.",
      "Inspect the git error, resolve the worktree removal problem manually, then retry finalize-cleanup.",
      "Branch deletion was not attempted; the feature branch was retained for recovery.",
    ],
    {
      worktreePath,
      featureBranch,
      stderr: stderr.text,
      stdout: stdout.text,
      truncated: stderr.truncated || stdout.truncated,
      recoveryOptions: SUBMODULE_RECOVERY_OPTIONS_FORCE,
    },
  );
}

function preflightWorktreeRemoval({ worktreePath, featureBranch, authorizedDirtyRootFiles,
  runtimeArtifacts = null, runGit: runGitFn }) {
  const inspection = inspectSubmoduleWorktreeCleanliness(worktreePath, runGitFn);
  if (!inspection.ok) {
    return {
      ok: false,
      env: worktreeStatusFailedEnvelope({ worktreePath, featureBranch, inspection }),
    };
  }
  const authorizedPaths = new Set([...authorizedDirtyRootFiles,
    ...inspection.dirtyRootFiles.filter((filePath) => runtimeArtifacts?.owns(filePath) === true)]);
  const unauthorizedRootFiles = inspection.dirtyRootFiles
    .filter((filePath) => !authorizedPaths.has(filePath));
  if (inspection.truncated || unauthorizedRootFiles.length > 0 || inspection.dirtySubmodules.length > 0) {
    return {
      ok: false,
      env: worktreeDirtyEnvelope({
        worktreePath,
        featureBranch,
        inspection: {
          ...inspection,
          dirtyRootFiles: unauthorizedRootFiles,
          dirty: true,
        },
      }),
    };
  }
  return {
    ok: true,
    authorizedResiduePresent: inspection.dirtyRootFiles.length > 0,
    authorizedDirtyRootFiles: inspection.dirtyRootFiles.filter((filePath) => authorizedPaths.has(filePath)),
  };
}

function removeGitWorktreeForCleanup({
  mainRepoPath,
  worktreePath,
  featureBranch,
  force,
  authorizedDirtyRootFiles = [],
  runGit: runGitFn,
}) {
  // --force is the caller's explicit authority to bypass normal dirty-tree
  // protection. Ordinary cleanup must prove its worktree is clean before the
  // first destructive Git operation.
  const preflight = force
    ? { ok: true, authorizedResiduePresent: false }
    : preflightWorktreeRemoval({
      worktreePath,
      featureBranch,
      authorizedDirtyRootFiles,
      runGit: runGitFn,
    });
  if (!preflight.ok) return preflight;

  const forceRemoval = force || preflight.authorizedResiduePresent;
  const removeArgs = ["-C", mainRepoPath, "worktree", "remove"];
  if (forceRemoval) removeArgs.push("--force");
  removeArgs.push(worktreePath);
  const removeRes = runGitFn(removeArgs);
  if (removeRes.ok) return { ok: true };

  const submoduleRemoval = isSubmoduleWorktreeRemoveFailure(removeRes);
  if (!submoduleRemoval) {
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "WORKTREE_REMOVE_FAILED", [
        `git worktree remove failed: ${removeRes.stderr || removeRes.stdout || "unknown"}`,
        "Common cause: untracked files or uncommitted changes in the worktree.",
        "Resolve the dirty state and retry cleanup.",
      ]),
    };
  }

  if (forceRemoval) {
    return {
      ok: false,
      env: worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res: removeRes }),
    };
  }

  const forceRes = runGitFn(["-C", mainRepoPath, "worktree", "remove", "--force", worktreePath]);
  if (!forceRes.ok) {
    return {
      ok: false,
      env: worktreeForceRemoveFailedEnvelope({ worktreePath, featureBranch, res: forceRes }),
    };
  }
  return { ok: true };
}

function bindingFailure(code, error) {
  return {
    ok: false,
    env: Envelope.fail("run", "finalize-cleanup", code, error.message, { failureKind: "step-admission" }),
  };
}

function cleanupWorktreeBinding({ flowManager, state, worktreePath }) {
  const manager = flowManager.forRoot(worktreePath, { specId: state.specId });
  return manager.usesWorktreeFlowBinding() ? new WorktreeFlowIdentity({
    runId: state.runId, issue: state.issue ?? null, specId: state.specId, worktreePath,
  }) : null;
}

function verifyExactWorktreeBinding(expectedBinding, missingBindingRecoveryAuthorized) {
  const store = new WorktreeFlowBindingStore({ worktreePath: expectedBinding.worktreePath });
  store.withLock(() => {
    if (!store.exists && missingBindingRecoveryAuthorized) return;
    const current = store.loadOwned().identity;
    if (!current.equals(expectedBinding)) {
      throw new Error("worktree flow binding changed before finalize teardown");
    }
  });
}

export function removeWorktreeForCleanup({
  mainRepoPath,
  worktreePath,
  featureBranch,
  force = false,
  runGit: runGitFn = runGit,
  expectedBinding = null,
  missingBindingRecoveryAuthorized = false,
  authorizedDirtyRootFiles = [],
}) {
  if (typeof missingBindingRecoveryAuthorized !== "boolean") {
    throw new Error("worktree cleanup missing-binding recovery authority must be boolean");
  }
  if (missingBindingRecoveryAuthorized && expectedBinding == null) {
    throw new Error("worktree cleanup missing-binding recovery requires an expected binding");
  }
  if (expectedBinding != null) {
    if (!(expectedBinding instanceof WorktreeFlowIdentity)) {
      throw new Error("worktree cleanup expected binding must be a worktree flow identity");
    }
    try {
      verifyExactWorktreeBinding(expectedBinding, missingBindingRecoveryAuthorized);
    } catch (error) {
      return bindingFailure("WORKTREE_FLOW_BINDING_REMOVE_FAILED", error);
    }
  }

  return removeGitWorktreeForCleanup({
    mainRepoPath,
    worktreePath,
    featureBranch,
    force,
    authorizedDirtyRootFiles,
    runGit: runGitFn,
  });
}

export function deleteFeatureBranchForCleanup({
  mainRepoPath,
  featureBranch,
  expectedSha,
  runGit: runGitFn = runGit,
}) {
  if (!GIT_OBJECT_ID.test(String(expectedSha))) throw new Error("feature branch deletion requires an expected OID");
  const ref = `refs/heads/${featureBranch}`;
  const observe = () => GitRefObservation.resolve({ root: mainRepoPath, ref, runGit: runGitFn });
  let branchRes = null;
  try {
    if (observe().absent) return { ok: true };
    const worktrees = runGitFn(["-C", mainRepoPath, "worktree", "list", "--porcelain"]);
    if (!worktrees.ok) {
      return {
        ok: false,
        env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
          `Feature branch worktree ownership could not be verified: ${worktrees.stderr || worktrees.stdout || "unknown"}`,
        ], { failureKind: "step-admission" }),
      };
    }
    if (worktrees.stdout.split("\n").some((line) => line === `branch ${ref}`)) {
      return {
        ok: false,
        env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
          `Feature branch is still checked out in a registered worktree: ${featureBranch}`,
        ], { failureKind: "step-admission" }),
      };
    }
    branchRes = runGitFn(["-C", mainRepoPath, "update-ref", "-d", ref, expectedSha]);
    if (!branchRes.ok) {
      if (observe().absent) return { ok: true };
      return {
        ok: false,
        env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
          `git update-ref -d ${ref} failed its expected-OID check: ${branchRes.stderr || branchRes.stdout || "unknown"}`,
        ]),
      };
    }
    return { ok: true };
  } catch (error) {
    if (!(error instanceof GitRefProbeError)) throw error;
    return {
      ok: false,
      env: Envelope.fail("run", "finalize-cleanup", "BRANCH_DELETE_FAILED", [
        ...(branchRes === null ? [] : [`git update-ref -d ${ref} failed: ${branchRes.stderr || branchRes.stdout || "unknown"}`]),
        error.message,
      ], { causeCode: error.code }),
    };
  }
}


export function finalizeCleanupPluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId }) {
  const completion = new FlowCompletion(state).toJSON();
  const specLocation = requiredSpecLocation(state);
  const inCleanupWorktree = Boolean(state?.worktree && worktreePath && mainRepoPath);
  if (!inCleanupWorktree) {
    return {
      root,
      artifactRepositoryRoot: specLocation.repositoryRoot,
      flow: { ...state, completion, specRoot: specLocation.relativeRoot },
      artifactPath: specLocation.relativeDirectory,
    };
  }

  // Plugin hooks retain their existing artifact-root input contract.  The
  // bound Version location is already repository-relative; resolving a
  // made-up `plugin-artifacts` logical key would bypass the catalog contract
  // and fails for V1 because collection members require an exact path.
  const artifactPath = specLocation.relativeDirectory;
  return {
    root: worktreePath,
    artifactRepositoryRoot: mainRepoPath,
    flow: { ...state, completion, specRoot: specLocation.relativeRoot },
    artifactPath,
  };
}

function finalizeCleanupPrePluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId }) {
  return finalizeCleanupPluginLifecycleContext({ root, state, worktreePath, mainRepoPath, specId });
}

function canonicalPluginArtifactContext(context, flowManager, specId) {
  return {
    ...context,
    artifactReader: (request) => flowManager.readArtifact({
      specId,
      consumerNodeId: "flow",
      ...request,
    }),
    publishArtifacts(writes) {
      if (!Array.isArray(writes) || writes.length === 0) return;
      flowManager.publishPluginArtifacts({
        specId,
        artifactWrites: writes.map((write) => new CanonicalFlowArtifactWrite(write)),
      });
    },
  };
}

function finalizePluginLifecycleFailure(error) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "PLUGIN_LIFECYCLE_FAILED",
    `Plugin finalize-cleanup lifecycle failed: ${error.message}`,
    { causeCode: error.code || null, pluginLifecycle: error.outcome || null },
  );
}

function finalizeRequiredPluginHookFailure(pluginLifecycle) {
  return Envelope.fail(
    "run",
    "finalize-cleanup",
    "PLUGIN_HOOK_REQUIRED_FAILED",
    `Plugin finalize-cleanup lifecycle failed: ${pluginLifecycle.outcome?.failure?.message || "required plugin hook failed"}`,
    { pluginLifecycle },
  );
}

function composeFinalizePluginLifecycle(pre, post) {
  return {
    ok: post.ok,
    outcome: post.outcome.kind === "business-failure" ? post.outcome : pre.outcome,
    data: {
      pluginHooks: [...pre.hookData, ...post.hookData],
      followUps: [...pre.followUps, ...post.followUps],
    },
    warnings: [...pre.warnings, ...post.warnings],
    issueLogEntries: [...pre.issueLogEntries, ...post.issueLogEntries],
  };
}

/**
 * Plugin side effects are outside the finalize-cleanup transaction boundary.
 * A pre hook may inspect state and veto cleanup, but sennel does not snapshot or
 * restore files or external systems changed by the plugin. Plugins that choose
 * to mutate state own idempotency, retry, recovery, and cleanup for that work.
 */
async function runFinalizePreHooks(pluginContext, state) {
  let pluginPre;
  try {
    const hooks = await discoverFlowCommandHooks(pluginContext.root);
    pluginPre = await runFlowCommandHooks(pluginContext.root, hooks, {
      command: "finalize-cleanup",
      hook: "pre",
      flow: pluginContext.flow,
      result: {},
      artifactRepositoryRoot: pluginContext.artifactRepositoryRoot || pluginContext.root,
      artifactReader: pluginContext.artifactReader,
    });
  } catch (err) {
    return { ok: false, env: finalizePluginLifecycleFailure(err) };
  }
  if (!pluginPre.ok) {
    return { ok: false, env: finalizeRequiredPluginHookFailure(pluginPre) };
  }
  pluginContext.publishArtifacts?.(pluginPre.artifactWrites);
  return { ok: true, pluginPre };
}

/**
 * Post-hook side effects are plugin-owned as well. A required failure remains
 * typed and stops Flow completion, but does not roll back plugin artifacts or
 * core cleanup that already crossed its durable teardown boundaries.
 */
async function runFinalizePostHooks(pluginContext, state, pluginPre, result) {
  try {
    const hooks = await discoverFlowCommandHooks(pluginContext.root);
    const pluginPost = await runFlowCommandHooks(pluginContext.root, hooks, {
      command: "finalize-cleanup", hook: "post", flow: pluginContext.flow, result,
      artifactRepositoryRoot: pluginContext.artifactRepositoryRoot || pluginContext.root,
      artifactReader: pluginContext.artifactReader,
    });
    if (pluginPost.ok) pluginContext.publishArtifacts?.(pluginPost.artifactWrites);
    return { ok: true, pluginLifecycle: composeFinalizePluginLifecycle(pluginPre, pluginPost) };
  } catch (err) {
    return { ok: false, env: finalizePluginLifecycleFailure(err) };
  }
}

/**
 * R1/R3/R6: parse `git log --reverse <baseline>..<featureBranch>` output into
 * { sha, subject } pairs and apply the 50-commit cap.
 */
function readOrphanCommits(repoPath, baseline, featureBranch) {
  const res = runGit([
    "-C",
    repoPath,
    "log",
    "--reverse",
    "--pretty=format:%H%x09%s",
    `${baseline}..${featureBranch}`,
  ]);
  if (!res.ok) {
    return { ok: false, reason: res.stderr || res.stdout || "git log failed" };
  }
  const lines = res.stdout.split("\n").filter(Boolean);
  const total = lines.length;
  const slice = lines.slice(0, ORPHAN_COMMIT_LIST_LIMIT);
  const commits = slice.map((line) => {
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) return { sha: line, subject: null };
    return { sha: line.slice(0, tabIdx), subject: line.slice(tabIdx + 1) };
  });
  return {
    ok: true,
    commits,
    count: total,
    truncated: total > ORPHAN_COMMIT_LIST_LIMIT,
  };
}

/**
 * R14/R15: append a single audit-log entry while keeping a snapshot of the
 * pre-write content so commit-time rollback restores the file exactly. Writes
 * unconditionally to the main repo (not the worktree, which may be deleted by
 * later teardown).
 */
function appendForcedFinalizeAudit(flowManager, state, authorization) {
  const droppedCommits = authorization.droppedCommits.map((commit) => commit.toJSON());
  flowManager.appendIssueLog({
    specId: state.specId,
    idempotencyKey: authorization.auditId,
    entry: {
      step: "finalize-cleanup",
      reason: "FORCED_ORPHAN_DROP: feature branch deleted via --force despite orphan / divergent state",
      trigger: "sennel flow run finalize-cleanup --force",
      resolution: droppedCommits.length > 0
        ? `dropped ${authorization.droppedCount} commit(s); top sha=${droppedCommits[0]?.sha?.slice(0, 12) || "n/a"}`
        : authorization.diverged
        ? "baseline diverged (history rewrite); branch deleted without rescue"
        : "baseline missing; branch deleted without rescue",
      droppedCommits,
      droppedCount: authorization.droppedCount,
      droppedTruncated: authorization.droppedTruncated,
      taskId: null,
      timestamp: new Date().toISOString(),
    },
  });
}

function attachForcedFinalizeContext(env, authorization) {
  if (!env.ok || authorization.route !== "forced") return env;
  env.data.droppedCommits = authorization.droppedCommits.map((commit) => commit.toJSON());
  env.data.count = authorization.droppedCount;
  env.data.truncated = authorization.droppedTruncated;
  env.data.forceAuthorization = {
    auditId: authorization.auditId,
    mergeStrategy: authorization.mergeStrategy,
    baseline: authorization.baseline,
    diverged: authorization.diverged,
  };
  env.addWarning("FORCED_ORPHAN_DROP", [
    `Feature branch deleted with --force despite ${authorization.droppedCount} unsaved commit(s).`,
    "The dropped commit list has been recorded in issue-log.json for audit.",
  ]);
  return env;
}

class AutoRescueWorktreeAuthoritySource {
  constructor(mainRepoPath) {
    this.mainRepoPath = path.resolve(mainRepoPath);
  }

  capture(worktreePath, expectedHeadSha = null) {
    const resolvedWorktree = path.resolve(worktreePath);
    const worktreeStat = fs.lstatSync(resolvedWorktree);
    if (
      !worktreeStat.isDirectory()
      || worktreeStat.isSymbolicLink()
      || fs.realpathSync(resolvedWorktree) !== resolvedWorktree
    ) {
      throw new Error("auto-rescue worktree generation is not a real directory");
    }
    const dotGitPath = path.join(resolvedWorktree, ".git");
    const dotGitStat = fs.lstatSync(dotGitPath);
    if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink() || dotGitStat.nlink !== 1) {
      throw new Error("auto-rescue worktree Git pointer is not one real file");
    }
    const match = /^gitdir: (.+)\r?\n?$/.exec(fs.readFileSync(dotGitPath, "utf8"));
    if (!match) throw new Error("auto-rescue worktree Git pointer is malformed");
    const gitDirPath = path.resolve(path.dirname(dotGitPath), match[1]);
    const worktreesRoot = fs.realpathSync(path.join(this.mainRepoPath, ".git", "worktrees"));
    const realGitDirPath = fs.realpathSync(gitDirPath);
    if (path.dirname(realGitDirPath) !== worktreesRoot) {
      throw new Error("auto-rescue worktree Git directory is outside the repository authority");
    }
    const gitDirStat = fs.lstatSync(realGitDirPath);
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
      throw new Error("auto-rescue worktree Git directory is not a real directory");
    }
    const headSha = fs.readFileSync(path.join(realGitDirPath, "HEAD"), "utf8").trim();
    if (expectedHeadSha !== null && headSha !== expectedHeadSha) {
      throw new Error("auto-rescue worktree HEAD differs from the expected generation");
    }
    return new AutoRescueWorktreeAuthority({
      worktreeDev: worktreeStat.dev,
      worktreeIno: worktreeStat.ino,
      gitDirPath: realGitDirPath,
      gitDirDev: gitDirStat.dev,
      gitDirIno: gitDirStat.ino,
      headSha,
    });
  }

  assertCurrent(worktreePath, expected) {
    const authority = expected instanceof AutoRescueWorktreeAuthority
      ? expected
      : AutoRescueWorktreeAuthority.fromStored(expected);
    if (!authority.sameGeneration(this.capture(worktreePath, authority.headSha))) {
      throw new Error("auto-rescue temporary worktree generation changed before cleanup");
    }
  }

  assertAbsent(worktreePath, expected) {
    if (!pathIsAbsent(worktreePath) || !pathIsAbsent(expected.gitDirPath)) {
      throw new Error("auto-rescue temporary worktree generation remains after cleanup");
    }
  }
}

function autoRescueCleanupError(journal, result, { worktreeResidue = null } = {}) {
  const error = new Error(
    `temporary auto-rescue worktree cleanup failed: ${result.stderr || result.stdout || "unknown error"}`,
  );
  error.code = "AUTO_RESCUE_CLEANUP_FAILED";
  error.cleanupAuthority = {
    journalPath: null,
    tempWorktreePath: journal.tempWorktreePath,
    expectedBaseSha: journal.expectedBaseSha,
    expectedUpdatedSha: journal.expectedUpdatedSha,
    phase: journal.phase,
    residue: { worktree: worktreeResidue, journal: true },
  };
  return error;
}

function pathIsAbsent(filePath) {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function removeAutoRescueWorktree(runGitFn, journal, worktreeAuthoritySource) {
  const worktrees = runGitFn(["-C", journal.identity.mainRepoPath, "worktree", "list", "--porcelain"]);
  if (!worktrees.ok) return { ok: false, error: autoRescueCleanupError(journal, worktrees) };
  const registered = worktrees.stdout.split("\n").includes(`worktree ${journal.tempWorktreePath}`);
  if (registered) {
    if (journal.worktreeAuthority == null) {
      return {
        ok: false,
        error: autoRescueCleanupError(
          journal,
          { stderr: "registered temporary worktree has no durable generation authority" },
          { worktreeResidue: true },
        ),
      };
    }
    try {
      worktreeAuthoritySource.assertCurrent(journal.tempWorktreePath, journal.worktreeAuthority);
    } catch (error) {
      return {
        ok: false,
        error: autoRescueCleanupError(journal, { stderr: error.message }, { worktreeResidue: true }),
      };
    }
    const cleanupRes = runGitFn([
      "-C", journal.identity.mainRepoPath, "worktree", "remove", "--force", journal.tempWorktreePath,
    ]);
    if (!cleanupRes.ok) {
      return {
        ok: false,
        error: autoRescueCleanupError(journal, cleanupRes, { worktreeResidue: true }),
      };
    }
  } else {
    try {
      fs.lstatSync(journal.tempWorktreePath);
      return {
        ok: false,
        error: autoRescueCleanupError(
          journal,
          { stderr: "unregistered temporary path remains" },
          { worktreeResidue: true },
        ),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const verified = runGitFn(["-C", journal.identity.mainRepoPath, "worktree", "list", "--porcelain"]);
  let generationAbsent = true;
  if (journal.worktreeAuthority != null) {
    try {
      worktreeAuthoritySource.assertAbsent(journal.tempWorktreePath, journal.worktreeAuthority);
    } catch {
      generationAbsent = false;
    }
  }
  if (
    !verified.ok
    || verified.stdout.split("\n").includes(`worktree ${journal.tempWorktreePath}`)
    || !pathIsAbsent(journal.tempWorktreePath)
    || !generationAbsent
  ) {
    return {
      ok: false,
      error: autoRescueCleanupError(journal, verified, {
        worktreeResidue: verified.ok ? true : null,
      }),
    };
  }
  return { ok: true };
}

/**
 * R8/R9 auto-rescue cherry-pick driver. Returns one of:
 *   { ok: true, intoBranch, commits }                            — cherry-pick succeeded.
 *   { ok: false, code: "MAIN_REPO_DIRTY", dirtyFiles }           — preflight dirty.
 *   { ok: false, code: "MAIN_REPO_LOCKED" }                      — checkout & fallback both failed.
 *   { ok: false, code: "CHERRY_PICK_CONFLICT", conflictFiles }   — cherry-pick conflict, restored.
 */
function autoRescueBodyError(outcome) {
  const primaryError = new Error(`auto-rescue body failed: ${outcome.code}`);
  primaryError.code = outcome.code;
  primaryError.conflictFiles = [...outcome.conflictFiles];
  if (!outcome.abortFailure) return primaryError;
  const abortError = outcome.abortFailure.toError();
  const error = new AggregateError(
    [primaryError, abortError],
    "auto-rescue cherry-pick and abort both failed",
    { cause: primaryError },
  );
  error.code = primaryError.code;
  error.conflictFiles = [...primaryError.conflictFiles];
  error.outcome = outcome.toJSON();
  return error;
}

function autoRescueRecoveryAuthority(store, journal, phase = journal.phase) {
  return {
    journalPath: store.path,
    tempWorktreePath: journal.tempWorktreePath,
    expectedBaseSha: journal.expectedBaseSha,
    phase,
    residue: { worktree: true, journal: true },
  };
}

function autoRescueCleanupFailure(store, journal, outcome, cleanupError) {
  journal.advance("cleanup-failed", outcome);
  cleanupError.cleanupAuthority.journalPath = store.path;
  cleanupError.cleanupAuthority.phase = journal.phase;
  try {
    store.write(journal);
  } catch (authorityError) {
    const error = new AggregateError(
      [cleanupError, authorityError],
      "auto-rescue cleanup and durable recovery publication both failed",
      { cause: cleanupError },
    );
    error.code = cleanupError.code;
    error.cleanupAuthority = cleanupError.cleanupAuthority;
    throw error;
  }
  if (outcome?.ok === false) {
    const primaryError = autoRescueBodyError(outcome);
    const error = new AggregateError(
      [primaryError, cleanupError],
      "auto-rescue body and temporary worktree cleanup both failed",
      { cause: primaryError },
    );
    error.code = "AUTO_RESCUE_CLEANUP_FAILED";
    error.cleanupAuthority = cleanupError.cleanupAuthority;
    error.bodyCode = primaryError.code;
    throw error;
  }
  return {
    ok: false,
    code: "AUTO_RESCUE_CLEANUP_FAILED",
    cleanupAuthority: cleanupError.cleanupAuthority,
  };
}

function completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource) {
  const cleanup = removeAutoRescueWorktree(runGitFn, journal, worktreeAuthoritySource);
  if (!cleanup.ok) return autoRescueCleanupFailure(store, journal, outcome, cleanup.error);
  if (outcome != null) {
    journal.advance("completed", outcome, journal.expectedUpdatedSha);
    try {
      store.write(journal);
    } catch (cause) {
      const cleanupError = autoRescueCleanupError(
        journal,
        { stderr: cause.message },
        { worktreeResidue: false },
      );
      cleanupError.cause = cause;
      return autoRescueCleanupFailure(store, journal, outcome, cleanupError);
    }
  } else {
    store.remove();
  }
  return outcome?.toJSON() ?? null;
}

function baseBranchIsCheckedOut(mainRepoPath, baseBranch) {
  try {
    return fs.readFileSync(path.join(mainRepoPath, ".git", "HEAD"), "utf8").trim()
      === `ref: refs/heads/${baseBranch}`;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function autoRescueAuthorityFailure(store, journal, message) {
  const error = new Error(message);
  error.code = "AUTO_RESCUE_CLEANUP_FAILED";
  error.cleanupAuthority = autoRescueRecoveryAuthority(store, journal, journal.phase);
  return error;
}

function assertAutoRescueUpdatedRef(store, journal, runGitFn) {
  const baseRef = `refs/heads/${journal.identity.baseBranch}`;
  const current = runGitFn(["-C", journal.identity.mainRepoPath, "rev-parse", "--verify", baseRef]);
  if (!current.ok || current.stdout.trim() !== journal.expectedUpdatedSha) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue updated base ref diverged from journal authority");
  }
}

function materializeAutoRescueBase(store, journal, runGitFn) {
  assertAutoRescueUpdatedRef(store, journal, runGitFn);
  if (!journal.materializeBase) return;
  const baseRef = `refs/heads/${journal.identity.baseBranch}`;
  const headRef = runGitFn(["-C", journal.identity.mainRepoPath, "symbolic-ref", "-q", "HEAD"]);
  if (!headRef.ok || headRef.stdout.trim() !== baseRef) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout authority changed before materialization");
  }
  const oldIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedBaseSha, "--",
  ]);
  const updatedIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedUpdatedSha, "--",
  ]);
  if (oldIndex.ok) {
    const materialized = runGitFn([
      "-C", journal.identity.mainRepoPath,
      "read-tree", "-u", "-m", journal.expectedBaseSha, journal.expectedUpdatedSha,
    ]);
    if (!materialized.ok) {
      throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout materialization failed");
    }
  } else if (!updatedIndex.ok) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue caller index diverged before materialization");
  }
  const verifiedIndex = runGitFn([
    "-C", journal.identity.mainRepoPath,
    "diff-index", "--cached", "--quiet", journal.expectedUpdatedSha, "--",
  ]);
  let dirtyFiles;
  try {
    dirtyFiles = listMainRepoDirtyFiles(
      journal.identity.mainRepoPath,
      journal.identity.specId,
      journal.identity.allowedIssueLogId,
      {
        allowFinalizeMetadata: journal.identity.allowFinalizeMetadata,
        specRoot: journal.identity.specRoot,
      },
    );
  } catch {
    dirtyFiles = null;
  }
  if (!verifiedIndex.ok || dirtyFiles == null || dirtyFiles.length > 0) {
    throw autoRescueAuthorityFailure(store, journal, "auto-rescue base checkout materialization is not clean");
  }
}

function probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn) {
  const probe = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
  return probe.ok ? probe.stdout.trim() : null;
}

export function runDetachedAutoRescue({
  mainRepoPath,
  baseBranch,
  baseline,
  featureBranch,
  specRoot = DEFAULT_FLOW_SPEC_DIR,
  specId,
  runId = null,
  allowedIssueLogId = null,
  allowFinalizeMetadata = false,
  range,
  runGitFn = runGit,
  worktreeAuthoritySource = new AutoRescueWorktreeAuthoritySource(mainRepoPath),
  tempWorktreePathFactory = null,
}) {
  const identity = autoRescueIdentity({
    mainRepoPath,
    baseBranch,
    baseline,
    featureBranch,
    specRoot,
    specId,
    runId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  });
  const store = new AutoRescueCleanupStore(identity);
  const existing = store.load();
  if (existing) {
    if (existing.phase === "ref-update-prepared") {
      const baseRef = `refs/heads/${baseBranch}`;
      const current = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
      const currentOid = current.ok ? current.stdout.trim() : null;
      if (currentOid === existing.expectedBaseSha) {
        const update = runGitFn([
          "-C", mainRepoPath, "update-ref", baseRef,
          existing.expectedUpdatedSha, existing.expectedBaseSha,
        ]);
        if (!update.ok) {
          const observedOid = probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn);
          if (observedOid === existing.expectedBaseSha) {
            const error = new Error("auto-rescue prepared ref update could not be resumed");
            error.code = "AUTO_RESCUE_CLEANUP_FAILED";
            error.cleanupAuthority = autoRescueRecoveryAuthority(store, existing, existing.phase);
            throw error;
          }
          if (observedOid !== existing.expectedUpdatedSha) {
            throw autoRescueAuthorityFailure(store, existing, "auto-rescue resumed ref update result is ambiguous");
          }
        }
      } else if (currentOid !== existing.expectedUpdatedSha) {
        const error = new Error("auto-rescue base ref diverged from both journaled OIDs");
        error.code = "AUTO_RESCUE_CLEANUP_FAILED";
        error.cleanupAuthority = autoRescueRecoveryAuthority(store, existing, existing.phase);
        throw error;
      }
      existing.advance("base-updated", existing.outcome, existing.expectedUpdatedSha);
      store.write(existing);
    }
    if (existing.phase === "base-updated") {
      materializeAutoRescueBase(store, existing, runGitFn);
      existing.advance("worktree-materialized", existing.outcome, existing.expectedUpdatedSha);
      store.write(existing);
    }
    if (["worktree-materialized", "completed"].includes(existing.phase) && existing.outcome?.ok) {
      assertAutoRescueUpdatedRef(store, existing, runGitFn);
    }
    const recoveredOutcome = existing.outcome;
    const recovered = completeAutoRescueCleanup(
      store,
      existing,
      recoveredOutcome,
      runGitFn,
      worktreeAuthoritySource,
    );
    if (recovered !== null) return recovered;
  }

  const baseRef = `refs/heads/${baseBranch}`;
  const baseProbe = runGitFn(["-C", mainRepoPath, "rev-parse", "--verify", baseRef]);
  if (!baseProbe.ok || !GIT_OBJECT_ID.test(baseProbe.stdout.trim())) {
    return AutoRescueOutcome.failure("MAIN_REPO_LOCKED").toJSON();
  }
  const expectedBaseSha = baseProbe.stdout.trim();
  const temporaryPaths = new TemporaryPaths(mainRepoPath);
  const tempWorktreePath = tempWorktreePathFactory
    ? tempWorktreePathFactory()
    : temporaryPaths.create(autoRescueTemporaryDirectory(identity), PRODUCT.temporaryPrefix("rescue-tmp"));
  const journal = AutoRescueCleanupJournal.create(
    identity,
    expectedBaseSha,
    tempWorktreePath,
    baseBranchIsCheckedOut(mainRepoPath, baseBranch),
  );
  store.write(journal);
  const addRes = runGitFn([
    "-C", mainRepoPath, "worktree", "add", "--detach", tempWorktreePath, expectedBaseSha,
  ]);
  if (!addRes.ok) {
    if (tempWorktreePathFactory === null) {
      temporaryPaths.validate(tempWorktreePath);
      try { fs.rmdirSync(tempWorktreePath); } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      }
    }
    const outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
    journal.advance("body-failed", outcome);
    store.write(journal);
    return completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource);
  }
  journal.recordWorktreeAuthority(worktreeAuthoritySource.capture(tempWorktreePath, expectedBaseSha));
  journal.advance("worktree-added");
  store.write(journal);

  let outcome;
  try {
    outcome = AutoRescueOutcome.fromResult(cherryPickRange(tempWorktreePath, range, runGitFn));
  } catch (primaryError) {
    if (primaryError.code !== "AUTO_RESCUE_CONFLICT_PROBE_FAILED") throw primaryError;
    const cleanup = completeAutoRescueCleanup(store, journal, null, runGitFn, worktreeAuthoritySource);
    if (cleanup?.ok === false) {
      const cleanupError = Object.assign(new Error("auto-rescue cleanup failed after Git probe failure"), {
        code: cleanup.code,
        cleanupAuthority: cleanup.cleanupAuthority,
      });
      throw new AggregateError(
        [primaryError, cleanupError],
        "auto-rescue Git probe and temporary worktree cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  journal.recordWorktreeAuthority(worktreeAuthoritySource.capture(tempWorktreePath));
  if (outcome.abortFailure) {
    journal.advance("abort-failed", outcome);
    try {
      store.write(journal);
    } catch (authorityError) {
      const bodyError = autoRescueBodyError(outcome);
      throw new AggregateError(
        [bodyError, authorityError],
        "auto-rescue abort failure and durable recovery publication both failed",
        { cause: bodyError },
      );
    }
    const error = autoRescueBodyError(outcome);
    error.cleanupAuthority = autoRescueRecoveryAuthority(store, journal);
    throw error;
  }
  if (outcome.ok) {
    const headRes = runGitFn(["-C", tempWorktreePath, "rev-parse", "HEAD"]);
    if (!headRes.ok || !GIT_OBJECT_ID.test(headRes.stdout.trim())) {
      outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
    } else {
      const updatedSha = headRes.stdout.trim();
      journal.advance("ref-update-prepared", outcome, updatedSha);
      store.write(journal);
      const updateRes = runGitFn([
        "-C",
        mainRepoPath,
        "update-ref",
        baseRef,
        updatedSha,
        expectedBaseSha,
      ]);
      if (!updateRes.ok) {
        const observedOid = probeAutoRescueRefOid(mainRepoPath, baseRef, runGitFn);
        if (observedOid === updatedSha) {
          outcome = AutoRescueOutcome.success();
        } else if (observedOid === expectedBaseSha) {
          outcome = AutoRescueOutcome.failure("MAIN_REPO_LOCKED");
        } else {
          throw autoRescueAuthorityFailure(store, journal, "auto-rescue ref update result is ambiguous");
        }
      }
    }
  }
  journal.advance(outcome.ok ? "base-updated" : "body-failed", outcome);
  store.write(journal);
  if (outcome.ok) {
    materializeAutoRescueBase(store, journal, runGitFn);
    journal.advance("worktree-materialized", outcome, journal.expectedUpdatedSha);
    store.write(journal);
  }
  return completeAutoRescueCleanup(store, journal, outcome, runGitFn, worktreeAuthoritySource);
}

export function runAutoRescue({
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
  const range = `${baseline}..${featureBranch}`;
  const identity = autoRescueIdentity({
    mainRepoPath,
    baseBranch,
    baseline,
    featureBranch,
    specRoot,
    specId,
    runId,
    allowedIssueLogId,
    allowFinalizeMetadata,
  });
  const pendingCleanup = new AutoRescueCleanupStore(identity).load();
  if (pendingCleanup) {
    try {
      return runDetachedAutoRescue({
        mainRepoPath,
        baseBranch,
        baseline,
        featureBranch,
        specRoot,
        specId,
        runId,
        range,
        allowedIssueLogId,
        allowFinalizeMetadata,
      });
    } catch (error) {
      if (error.code !== "AUTO_RESCUE_CLEANUP_FAILED") throw error;
      return {
        ok: false,
        code: error.code,
        bodyCode: error.bodyCode || null,
        cleanupAuthority: error.cleanupAuthority,
      };
    }
  }

  let dirtyFiles;
  try {
    dirtyFiles = listMainRepoDirtyFiles(mainRepoPath, specId, allowedIssueLogId, {
      allowFinalizeMetadata,
      specRoot,
    });
  } catch (error) {
    return { ok: false, code: error.code || "MAIN_REPO_STATUS_FAILED", message: error.message };
  }
  if (dirtyFiles.length > 0) {
    return { ok: false, code: "MAIN_REPO_DIRTY", dirtyFiles };
  }

  try {
    return runDetachedAutoRescue({
      mainRepoPath,
      baseBranch,
      baseline,
      featureBranch,
      specRoot,
      specId,
      runId,
      range,
      allowedIssueLogId,
      allowFinalizeMetadata,
    });
  } catch (error) {
    if (error.code === "CHERRY_PICK_CONFLICT" && error.outcome?.abortFailure) {
      return { ...error.outcome, cleanupAuthority: error.cleanupAuthority };
    }
    if (error.code !== "AUTO_RESCUE_CLEANUP_FAILED") throw error;
    return {
      ok: false,
      code: error.code,
      bodyCode: error.bodyCode || null,
      cleanupAuthority: error.cleanupAuthority,
    };
  }
}

/**
 * Run `git cherry-pick <range>` with empty-patch tolerance. On the first
 * conflict, abort and return CHERRY_PICK_CONFLICT.
 */
function cherryPickRange(repoPath, range, runGitFn = runGit) {
  // --allow-empty makes `git cherry-pick` skip empty commits silently;
  // duplicate-content commits still need `--skip` recovery below.
  let res = runGitFn(["-C", repoPath, "cherry-pick", range]);
  while (!res.ok) {
    const text = `${res.stdout || ""}\n${res.stderr || ""}`;
    if (/nothing to commit|previous cherry-pick is now empty/i.test(text)) {
      // Duplicate / empty patch — skip and continue with the rest.
      const skip = runGitFn(["-C", repoPath, "cherry-pick", "--skip"]);
      if (!skip.ok) {
        // --skip itself may fail (no in-progress cherry-pick); abort defensively.
        const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
        const abortFailure = abort.ok ? null : AutoRescueAbortFailure.fromGitResult(abort);
        return AutoRescueOutcome.failure(
          "CHERRY_PICK_CONFLICT",
          [],
          abortFailure,
        ).toJSON();
      }
      // After --skip, git may have completed the sequence (skip succeeded with
      // nothing more to do) or be ready for the next commit. Probe with the
      // continuation form: another cherry-pick command is not needed — `--skip`
      // continues the in-progress sequence on its own.
      res = skip;
      // Determine whether a cherry-pick is still in progress; if not, we're done.
      const stateProbe = runGitFn(["-C", repoPath, "rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"]);
      if (!stateProbe.ok) {
        if (stateProbe.status === 1 && !stateProbe.stdout && !stateProbe.stderr) {
          // No in-progress cherry-pick → sequence completed.
          break;
        }
        const error = new Error(`cherry-pick state probe failed: ${stateProbe.stderr || stateProbe.stdout || "unknown Git error"}`);
        error.code = "AUTO_RESCUE_CHERRY_PICK_STATE_FAILED";
        throw error;
      }
      continue;
    }
    // Genuine conflict.
    const statusRes = runGitFn(["-C", repoPath, "diff", "--name-only", "--diff-filter=U"]);
    if (!statusRes.ok) {
      const primaryError = gitFailure(
        "AUTO_RESCUE_CONFLICT_PROBE_FAILED",
        "cherry-pick conflict file probe failed",
        statusRes,
      );
      const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
      if (!abort.ok) {
        const abortError = AutoRescueAbortFailure.fromGitResult(abort).toError();
        const error = new AggregateError(
          [primaryError, abortError],
          "auto-rescue conflict probe and abort both failed",
          { cause: primaryError },
        );
        error.code = primaryError.code;
        throw error;
      }
      throw primaryError;
    }
    const conflictFiles = statusRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const abort = runGitFn(["-C", repoPath, "cherry-pick", "--abort"]);
    const abortFailure = abort.ok ? null : AutoRescueAbortFailure.fromGitResult(abort);
    return AutoRescueOutcome.failure(
      "CHERRY_PICK_CONFLICT",
      conflictFiles,
      abortFailure,
    ).toJSON();
  }
  return { ok: true };
}

function finalizeSyncWarning(state, outboxStore) {
  if (!(outboxStore instanceof FlowOutboxStore)) {
    throw new Error("finalize-sync warning requires the canonical outbox Store");
  }
  const identity = finalizationOutboxIdentity(state, "finalize-sync");
  const entry = outboxStore.status(identity);
  if (entry?.status !== "failed") return null;
  const failure = entry.latestFailure;
  return {
    code: failure?.code || "FINALIZE_SYNC_FAILED",
    message: entry.failure,
    recordedAt: failure?.recordedAt || entry.updatedAt,
    ...(failure?.code === "FINALIZE_SYNC_INTERRUPTED" ? { interrupted: true } : {}),
  };
}

export function executeFinalizeCleanupInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalize cleanup execution requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

function cleanupAdmissionRefusal(envelope) {
  const refusal = new StepAdmissionRefusal(envelope.errors[0].messages.join("\n"));
  refusal.code = envelope.errors[0].code;
  refusal.data = envelope.data;
  return refusal;
}

/** Acquired worktree admission and the existing journal's resume capability. */
class FinalizeCleanupEffectAdmission {
  constructor({ journalPreparation, worktreeBinding, worktreePath, featureBranch, authorizedDirtyRootFiles, force }) {
    this.journalPreparation = journalPreparation;
    this.worktreeBinding = worktreeBinding;
    this.worktreePath = worktreePath;
    this.featureBranch = featureBranch;
    this.authorizedDirtyRootFiles = Object.freeze([...authorizedDirtyRootFiles]);
    this.force = force;
    this.resumed = journalPreparation?.resumed === true;
    Object.freeze(this);
  }
  executionForBinding(binding) { return this.journalPreparation.executionForBinding(binding); }
  assertCurrent(ctx) {
    this.journalPreparation?.assertCurrent(ctx);
    if (this.worktreeBinding !== null) {
      try { verifyExactWorktreeBinding(this.worktreeBinding, false); }
      catch (error) {
        const refusal = new StepAdmissionRefusal(error.message, error);
        refusal.code = "WORKTREE_FLOW_BINDING_REMOVE_FAILED";
        throw refusal;
      }
    }
    if (this.worktreePath !== null && pathExistsStrict(this.worktreePath) && !this.force) {
      const preflight = preflightWorktreeRemoval({ worktreePath: this.worktreePath,
        featureBranch: this.featureBranch, authorizedDirtyRootFiles: this.authorizedDirtyRootFiles, runGit });
      if (!preflight.ok) throw cleanupAdmissionRefusal(preflight.env);
    }
  }
}

export class RunFinalizeCleanupCommand extends FlowCommand {
  constructor() {
    super({ explicitTargetResolution: true });
  }

  async execute(ctx) {
    return withFlowProcessRuntime(ctx, () => executeFinalizationCommand({
      ctx, command: this, stepId: "finalize-cleanup", executeInput: (input) => executeFinalizeCleanupInput(input),
    }), { commandId: "finalize-cleanup",
      physicalAuthority: (context) => captureFinalizationProcessAuthority(context, "finalize-cleanup") });
  }

  projectCompletedReceipt(ctx, receipt) {
    const stateOwner = FinalizeFlowStateOwner.forMainContext(ctx);
    return projectFinalizeCleanupCompletedReceipt({ stateOwner, settlementReceipt: receipt });
  }

  async prepareEffect(ctx) {
    if (ctx.autoRescue && ctx.force) {
      const refusal = new StepAdmissionRefusal("--auto-rescue and --force are mutually exclusive. Pass at most one.");
      refusal.code = "ARGS_ERROR";
      throw refusal;
    }
    const resolution = FinalizeCleanupStateResolution.resolve(ctx);
    if (resolution instanceof Envelope) throw cleanupAdmissionRefusal(resolution);
    assertObservableFinalizeGitStatus(resolution.stateOwner.mainRepoPath);
    let worktreeBinding = null;
    let authorizedDirtyRootFiles = [];
    if (resolution.state.worktree && resolution.worktreePath && pathExistsStrict(resolution.worktreePath)) {
      try {
        worktreeBinding = cleanupWorktreeBinding({ flowManager: resolution.stateOwner.flowManager,
          state: resolution.state, worktreePath: resolution.worktreePath });
        if (worktreeBinding !== null) verifyExactWorktreeBinding(worktreeBinding, false);
      } catch (error) {
        const refusal = new StepAdmissionRefusal(error.message, error);
        refusal.code = "WORKTREE_FLOW_BINDING_REMOVE_FAILED";
        throw refusal;
      }
      if (ctx.force !== true) {
        const preflight = preflightWorktreeRemoval({ worktreePath: resolution.worktreePath,
          featureBranch: resolution.state.featureBranch, authorizedDirtyRootFiles: [],
          runtimeArtifacts: new FlowRepositoryRuntimeArtifactRegistry(), runGit });
        if (!preflight.ok) throw cleanupAdmissionRefusal(preflight.env);
        authorizedDirtyRootFiles = preflight.authorizedDirtyRootFiles;
      }
    }
    try {
      const journalPreparation = FinalizeCleanupEffectPreparation.acquire(ctx);
      if (resolution.state.worktree && !pathExistsStrict(resolution.worktreePath) && journalPreparation === null) {
        const refusal = new StepAdmissionRefusal("Managed worktree is unavailable without its authenticated cleanup journal");
        refusal.code = "WORKTREE_FLOW_BINDING_REMOVE_FAILED";
        throw refusal;
      }
      return new FinalizeCleanupEffectAdmission({ journalPreparation,
        worktreeBinding, worktreePath: resolution.worktreePath, featureBranch: resolution.state.featureBranch,
        authorizedDirtyRootFiles, force: ctx.force === true });
    } catch (error) {
      if (error instanceof StepAdmissionRefusal) throw error;
      const refusal = new StepAdmissionRefusal(error.message, error);
      refusal.code = error.code;
      throw refusal;
    }
  }

  async executeEffect(ctx) {
    const mainRoot = ctx.mainRoot || ctx.flowManager?._mainRoot || ctx.root;
    const repositoryOperation = new RepositoryFlowOperationLock({
      mainRoot,
      operationOwnerToken: ctx.repositoryOperationOwnerToken || null,
    });
    let token;
    try {
      token = repositoryOperation.acquire();
    } catch (error) {
      if (["REPOSITORY_FLOW_OPERATION_BUSY", "REPOSITORY_MAINTENANCE_BUSY"].includes(error.code)) {
        return Envelope.fail("run", "finalize-cleanup", error.code, error.message,
          { failureKind: "step-admission", lockPath: error.lockPath });
      }
      throw error;
    }
    let result;
    let primaryError = null;
    try {
      result = await this.executeOwned({
        ...ctx,
        repositoryOperationOwnerToken: token,
      });
    } catch (error) {
      primaryError = error;
    }
    let releaseError = null;
    try {
      repositoryOperation.release();
    } catch (error) {
      releaseError = error;
    }
    if (primaryError && releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        "finalize operation and repository barrier release both failed",
        { cause: primaryError },
      );
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    return result;
  }

  async executeOwned(ctx) {
    const resolution = FinalizeCleanupStateResolution.resolve(ctx);
    if (resolution instanceof Envelope) return resolution;
    ctx = resolution.stateOwner.bindContext({
      ...ctx,
      flowState: resolution.state,
      finalizeCleanupStateResolution: resolution,
    });
    const { root, autoRescue, force } = ctx;
    const state = resolution.state;
    const { worktreePath, mainRepoPath } = resolution;
    const { baseBranch, worktree } = state;
    const featureBranch = state.execution.mode === "direct" ? baseBranch : state.featureBranch;
    const specId = state.specId;
    const reportRoot = mainRepoPath || root;

    // ── Stage (A) — args validation ─────────────────────────────────────────
    if (autoRescue && force) {
      return Envelope.fail("run", "finalize-cleanup", "ARGS_ERROR", [
        "--auto-rescue and --force are mutually exclusive. Pass at most one.",
      ], { failureKind: "step-admission" });
    }

    const pluginContext = canonicalPluginArtifactContext(finalizeCleanupPrePluginLifecycleContext({
      root,
      state,
      worktreePath,
      mainRepoPath,
      specId,
    }), resolution.stateOwner.flowManager, specId);
    const preResult = await runFinalizePreHooks(pluginContext, state);
    if (!preResult.ok) return preResult.env;
    ctx = { ...ctx, finalizePluginContext: pluginContext, finalizePluginPre: preResult.pluginPre };

    if (featureBranch !== baseBranch) {
      const resumed = await runPersistedTeardownIfPresent(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
      });
      if (resumed != null) return resumed;
      const targetRoot = (worktree && mainRepoPath) ? mainRepoPath : root;
      try {
        assertInitialFinalizeGitAuthority({
          targetRoot,
          state,
          worktreePath: worktree && mainRepoPath ? (worktreePath || root) : null,
        });
      } catch (error) {
        const refusal = new StepAdmissionRefusal(error.message, error);
        refusal.code = error.code;
        throw refusal;
      }
    }

    // Spec-only mode has no worktree or feature branch to remove, but shares
    // the same durable final-state and post-command commit boundary.
    if (featureBranch === baseBranch) {
      return runSharedSpecTeardown(ctx, {
        worktreePath: null,
        mainRepoPath: ctx.mainRoot || root,
        reportRoot,
        specId,
      });
    }

    // ── Stage (B) — route routing ───────────────────────────────────────────
    const mergeOutcome = new FlowOutboxStore(resolution.stateOwner.flowManager, { specId })
      .status(finalizationOutboxIdentity(state, "finalize-merge"))?.result ?? null;
    const persistedStrategy = mergeOutcome?.strategy ?? null;
    const baseline = mergeOutcome?.mergedFromSha ?? null;

    if (persistedStrategy === "pr") {
      // PR route — orphan detection is out of scope (Issue #316). Proceed
      // straight into the existing teardown transaction.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    if (persistedStrategy !== "squash") {
      // The canonical finalize-merge receipt is missing or corrupt. Halt unless
      // the user explicitly waives baseline checking via --force.
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_MISSING",
          [
            "Squash baseline is not recorded in the canonical finalize-merge receipt.",
            "Detection cannot run safely. Recovery: archive the feature branch, inspect commits via patch, cherry-pick post-squash fixes onto baseBranch by hand, then re-run with --force.",
            "Resolve any cherry-pick state via `git cherry-pick --skip` or `git cherry-pick --abort` before retrying.",
          ],
          {
            failureKind: "step-admission",
            recordedSha: null,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      // --force path: skip detection, proceed to forced teardown with audit.
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline: null,
        featureBranch,
        baseBranch,
      });
    }

    // ── Stage (C) — orphan guard (squash route only) ────────────────────────
    if (!baseline) {
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_MISSING",
          [
            "Squash baseline SHA is missing for this squash-route flow.",
            "Detection cannot run safely. Recovery: archive the feature branch, inspect commits via patch, cherry-pick post-squash fixes onto baseBranch by hand, then re-run with --force.",
          ],
          {
            failureKind: "step-admission",
            recordedSha: null,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline: null,
        featureBranch,
        baseBranch,
      });
    }

    // R1: resolve the current featureBranch ref explicitly (NOT process HEAD;
    // in branch mode HEAD points at baseBranch by the time cleanup runs).
    const currentRes = runGit([
      "-C",
      mainRepoPath || root,
      "rev-parse",
      featureBranch,
    ]);
    if (!currentRes.ok) {
      return Envelope.fail("run", "finalize-cleanup", "BRANCH_REF_RESOLUTION_FAILED", [
        `Failed to resolve ref for ${featureBranch}: ${currentRes.stderr || currentRes.stdout}`,
      ], { failureKind: "step-admission" });
    }
    const currentSha = currentRes.stdout.trim();

    if (currentSha === baseline) {
      // No-op: feature branch unchanged since squash. Proceed to teardown.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    const ancestryRes = runGit([
      "-C",
      mainRepoPath || root,
      "merge-base",
      "--is-ancestor",
      baseline,
      featureBranch,
    ]);
    if (!ancestryRes.ok) {
      // Non-zero exit means baseline is NOT an ancestor of featureBranch
      // (history rewrite — rebase / amend / force-update).
      if (!force) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "SQUASH_BASELINE_DIVERGED",
          [
            "Squash baseline is no longer an ancestor of the feature branch.",
            "This indicates a history rewrite (rebase / amend / force-update).",
            "Recovery: archive the current branch, inspect commits via patch, cherry-pick fixes onto baseBranch manually, then re-run with --force.",
          ],
          {
            failureKind: "step-admission",
            recordedSha: baseline,
            currentSha,
            baseBranch,
            featureBranch,
            recoveryOptions: RECOVERY_OPTIONS_BASELINE,
          },
        );
      }
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline,
        featureBranch,
        baseBranch,
        diverged: true,
      });
    }

    // baseline is an ancestor and SHA differs → orphan commits exist.
    const orphan = readOrphanCommits(mainRepoPath || root, baseline, featureBranch);
    if (!orphan.ok) {
      return Envelope.fail("run", "finalize-cleanup", "ORPHAN_LISTING_FAILED", [
        `Failed to list orphan commits: ${orphan.reason}`,
      ], { failureKind: "step-admission" });
    }
    if (orphan.count === 0) {
      // Baseline differs from current SHA but the range is empty
      // (e.g. a merge commit with no exclusive commits). Treat as no-op.
      return runTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId });
    }

    if (autoRescue) {
      const rescue = runAutoRescue({
        mainRepoPath: mainRepoPath || root,
        baseBranch,
        baseline,
        featureBranch,
        specRoot: requiredSpecLocation(state).relativeRoot,
        specId,
        runId: state.runId,
        allowedIssueLogId: finalizeAuditId("cherry-pick-conflict", state, { baseline, featureBranch }),
        allowFinalizeMetadata: true,
      });
      if (rescue.ok) {
        return runTeardown({ ...ctx, finalizationRescued: new FinalizeRescuedCommits({
          commits: orphan.commits, intoBranch: baseBranch,
        }) }, { worktreePath, mainRepoPath, reportRoot, specId });
      }
      // Rescue failed — record audit log for CHERRY_PICK_CONFLICT, halt.
      if (rescue.code === "CHERRY_PICK_CONFLICT" && mainRepoPath) {
        try {
          ctx.flowManager.appendIssueLog({
            specId: state.specId,
            idempotencyKey: finalizeAuditId("cherry-pick-conflict", state, { baseline, featureBranch }),
            entry: {
              step: "finalize-cleanup",
              reason: "cherry-pick conflict during auto-rescue (worktree retained for manual recovery)",
              trigger: "sennel flow run finalize-cleanup --auto-rescue",
              resolution: rescue.abortFailure
                ? "cherry-pick abort failed; durable temporary-worktree cleanup authority retained for retry"
                : "cherry-pick aborted; user must resolve manually via archive + individual cherry-pick",
              taskId: null,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (err) {
          return Envelope.fail(
            "run",
            "finalize-cleanup",
            "ISSUE_LOG_AUDIT_FAILED",
            `Required cherry-pick conflict audit append failed: ${err.message}`,
            { failureKind: "step-persistence", originalCode: "CHERRY_PICK_CONFLICT", causeCode: err.code || null },
          );
        }
      }
      const failPayload = {
        recordedSha: baseline,
        currentSha,
        baseBranch,
        featureBranch,
        recoveryOptions: RECOVERY_OPTIONS_RESCUE_FAIL,
      };
      if (rescue.code === "MAIN_REPO_DIRTY") {
        failPayload.dirtyFiles = rescue.dirtyFiles;
        failPayload.recoveryOptions = RECOVERY_OPTIONS_DIRTY;
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "MAIN_REPO_DIRTY",
          [
            "Main repository has uncommitted changes that block auto-rescue.",
            "Commit or stash them, then retry with --auto-rescue, or retry without rescue and rescue manually.",
          ],
          failPayload,
        );
      }
      if (rescue.code === "MAIN_REPO_LOCKED") {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "MAIN_REPO_LOCKED",
          [
            `Failed to acquire baseBranch ${baseBranch} for auto-rescue (locked and detached fallback failed).`,
            "Resolve worktree contention manually and retry, or rescue manually.",
          ],
          failPayload,
        );
      }
      if (rescue.code === "AUTO_RESCUE_CLEANUP_FAILED") {
        failPayload.cleanupAuthority = rescue.cleanupAuthority;
        failPayload.bodyCode = rescue.bodyCode || null;
        failPayload.recoveryOptions = ["retry-auto-rescue-cleanup", "inspect-temporary-worktree"];
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          rescue.code,
          [
            "Auto-rescue stopped because its temporary worktree cleanup was not verified.",
            "Retry with --auto-rescue to resume the durable cleanup authority before teardown.",
          ],
          failPayload,
        );
      }
      // CHERRY_PICK_CONFLICT
      failPayload.conflictFiles = rescue.conflictFiles || [];
      if (rescue.abortFailure) {
        failPayload.abortFailure = rescue.abortFailure;
        failPayload.cleanupAuthority = rescue.cleanupAuthority;
        failPayload.recoveryOptions = ["retry-auto-rescue-cleanup", "inspect-temporary-worktree"];
      }
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "CHERRY_PICK_CONFLICT",
        [
          "Cherry-pick of orphan commits onto baseBranch produced a conflict.",
          "The worktree and feature branch are retained for manual recovery.",
          rescue.abortFailure
            ? "Cherry-pick abort also failed; retry with --auto-rescue to resume the durable temporary-worktree cleanup authority."
            : "Resolve any cherry-pick state via `git cherry-pick --skip` or `git cherry-pick --abort` if your local state is left in an in-progress cherry-pick.",
        ],
        failPayload,
      );
    }

    if (force) {
      return runForcedTeardown(ctx, {
        worktreePath,
        mainRepoPath,
        reportRoot,
        specId,
        baseline,
        featureBranch,
        baseBranch,
        droppedCommits: orphan.commits,
        droppedCount: orphan.count,
        droppedTruncated: orphan.truncated,
      });
    }

    // Default: detect-and-halt with the canonical user-facing recovery menu.
    return Envelope.fail(
      "run",
      "finalize-cleanup",
      "ORPHAN_COMMITS_DETECTED",
      [
        `Orphan commits detected on ${featureBranch} (${orphan.count} commit(s) beyond the recorded squash baseline).`,
        "These commits are not reachable from the recorded squash baseline and would be dropped by branch deletion.",
        "Recovery options:",
        "  - cherry-pick: re-run with `--auto-rescue` to cherry-pick orphan commits onto baseBranch",
        "  - abort: leave the worktree and feature branch as-is and inspect/handle manually",
        "  - force-continue: re-run with `--force` to delete the branch (commits will be lost; recorded to issue-log)",
      ],
      {
        failureKind: "step-admission",
        recordedSha: baseline,
        currentSha,
        count: orphan.count,
        truncated: orphan.truncated,
        orphanCommits: orphan.commits,
        baseBranch,
        featureBranch,
        recoveryOptions: RECOVERY_OPTIONS_DETECT,
      },
    );
  }
}

/**
 * Stage (D) — the original transactional teardown.
 * Extracted into a function so route routing and the no-op orphan path can
 * fall through to the same authoritative cleanup transaction.
 */
function resolveFeatureSha(root, featureBranch) {
  const result = runGit(["-C", root, "rev-parse", `refs/heads/${featureBranch}`]);
  if (!result.ok || !GIT_OBJECT_ID.test(result.stdout.trim())) {
    throw new Error(`finalize feature branch could not be resolved: ${featureBranch}`);
  }
  return result.stdout.trim();
}

function sharedFinalizeCompletionData(state, pluginLifecycle, outboxStore) {
  const completion = new FlowCompletion(state);
  const receipt = completion.toJSON();
  const syncWarning = finalizeSyncWarning(state, outboxStore);
  return {
    data: {
      status: "done",
      ...(state.execution.mode === "direct" ? { message: "spec-only mode" } : {}),
      ...(syncWarning ? { outcome: "completed_with_warnings", finalizeWarnings: [syncWarning] } : {}),
      assurance: completion.assurance,
      ...(receipt.advisorySummary && { advisorySummary: receipt.advisorySummary }),
      pluginHooks: pluginLifecycle.data?.pluginHooks || [],
      followUps: pluginLifecycle.data?.followUps || [],
    },
    syncWarning,
  };
}

/** Render the authenticated immutable cleanup outcome for completion or replay. */
function projectFinalizeCleanupCompletedReceipt({ stateOwner, settlementReceipt }) {
  const completedState = stateOwner.loadReadOnly();
  if (completedState.lifecycle !== "finalized") {
    throw new Error("Cleanup Completion projection requires its finalized canonical Flow");
  }
  const savedCommandResult = settlementReceipt.finalization.commandResult;
  const { data: completionData } = sharedFinalizeCompletionData(
    completedState,
    { data: savedCommandResult.data },
    stateOwner.outbox(),
  );
  const specRoot = requiredSpecLocation(completedState).relativeRoot;
  const env = attachReport(
    new Envelope({ ok: true, type: "run", key: "finalize-cleanup", data: {
      ...completionData, ...savedCommandResult.data, settlementReceipt: settlementReceipt.toJSON(),
    }, errors: [...savedCommandResult.errors] }),
    stateOwner.mainRepoPath,
    specRoot,
    stateOwner.specId,
  );
  if (completedState.worktree) {
    attachOtherFlowMetadataWarning(env, stateOwner.mainRepoPath, specRoot, completedState.specId);
  }
  return env;
}

function sharedFinalizeJournalReality(journal, { state, worktreePath, gitRoot, reportRoot, specId }) {
  if (journal.atLeast("worktree-removed")) {
    const validation = validateTeardown({
      worktreePath,
      mainRepoPath: gitRoot,
      featureBranch: state.featureBranch,
      specId,
      checkBranch: journal.atLeast("branch-deleted") && state.execution.mode !== "direct",
    });
    if (!validation.ok) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_TEARDOWN_JOURNAL_DIVERGED",
        validation.reasons,
      );
    }
  }
  if (journal.atLeast("pointer-written")) {
    try {
      assertPointerReality(reportRoot, specId);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_TEARDOWN_JOURNAL_DIVERGED",
        error.message,
      );
    }
  }
  return null;
}

async function runSharedSpecTeardown(ctx, { worktreePath, mainRepoPath, reportRoot, specId, authorization = null }) {
  const state = ctx.flowState;
  const gitRoot = mainRepoPath || ctx.root;
  const stateOwner = FinalizeFlowStateOwner.forMainContext({ ...ctx, specId });
  const execution = ctx.finalizationExecution ?? stateOwner.flowManager.readCurrentStepSettlement({
    specId, stepId: "finalize-cleanup",
  })?.result.execution ?? null;
  const journal = SharedFinalizeCleanupJournal.open(state);
  if (execution === null && !(journal.value !== null && journal.atLeast("completed"))
    && stateOwner.loadReadOnly().lifecycle !== "finalized") {
    throw new Error("Finalize cleanup requires its durable Execution identity before teardown");
  }
  if (journal.value == null) {
    stateOwner.flowManager.assertFlowStateWritable(specId, {
      operationOwnerToken: ctx.repositoryOperationOwnerToken,
    });
  }
  const featureSha = journal.value?.featureSha || resolveFeatureSha(gitRoot, state.execution.mode === "direct" ? state.baseBranch : state.featureBranch);
  const selectedAuthorization = authorization ?? FinalizeTeardownAuthorization.standard(state);
  if (journal.value !== null && authorization !== null
    && JSON.stringify(journal.value.authorization) !== JSON.stringify(authorization.toJSON())) {
    throw new Error("Shared finalize cleanup authorization changed after journal preparation");
  }
  const executionCheckpoint = stateOwner.flowManager.readCurrentStepSettlement({ specId, stepId: "finalize-cleanup" });
  journal.begin({ state, worktreePath, featureSha, baseSha: resolveFeatureSha(gitRoot, state.baseBranch), authorization: selectedAuthorization, execution,
    executionReceiptId: executionCheckpoint?.receipt.id, rescued: ctx.finalizationRescued ?? null });
  authorization = FinalizeTeardownAuthorization.fromStored(journal.value.authorization);
  const journalDivergence = sharedFinalizeJournalReality(journal, {
    state,
    worktreePath,
    gitRoot,
    reportRoot,
    specId,
  });
  if (journalDivergence) return journalDivergence;

  if (authorization?.route === "forced" && !journal.atLeast("worktree-removed")) {
    try {
      appendForcedFinalizeAudit(stateOwner.flowManager, state, authorization);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "ISSUE_LOG_AUDIT_FAILED",
        `Forced finalize audit could not be recorded: ${error.message}`,
        { failureKind: "step-persistence", causeCode: error.code || null },
      );
    }
  }

  if (!journal.atLeast("worktree-removed")) {
    if (state.worktree && worktreePath && pathExistsStrict(worktreePath)) {
      const worktreeHead = runGit(["-C", worktreePath, "rev-parse", "HEAD"]);
      if (!worktreeHead.ok || worktreeHead.stdout.trim() !== journal.value.featureSha) {
        return Envelope.fail(
          "run",
          "finalize-cleanup",
          "FINALIZE_WORKTREE_HEAD_CHANGED",
          `Managed worktree HEAD no longer matches ${state.featureBranch}; cleanup retained it for inspection.`,
          {
            expectedSha: journal.value.featureSha,
            actualSha: worktreeHead.ok ? worktreeHead.stdout.trim() : null,
          },
        );
      }
      const expectedBinding = cleanupWorktreeBinding({ flowManager: ctx.flowManager, state, worktreePath });
      const removed = removeWorktreeForCleanup({
        mainRepoPath: gitRoot,
        worktreePath,
        featureBranch: state.featureBranch,
        force: ctx.force === true,
        expectedBinding,
        authorizedDirtyRootFiles: ctx.finalizationEffectPreparation?.authorizedDirtyRootFiles ?? [],
      });
      if (!removed.ok) return removed.env;
    } else if (state.worktree && worktreePath) {
      const validation = validateTeardown({
        worktreePath,
        mainRepoPath: gitRoot,
        featureBranch: state.featureBranch,
        specId,
        checkBranch: false,
      });
      if (!validation.ok) {
        return Envelope.fail("run", "finalize-cleanup", "WORKTREE_REMOVAL_RECOVERY_FAILED", validation.reasons);
      }
    }
    journal.advance("worktree-removed");
  }

  if (!journal.atLeast("branch-deleted")) {
    if (state.execution.mode !== "direct") {
      const deleted = deleteFeatureBranchForCleanup({
        mainRepoPath: gitRoot,
        featureBranch: state.featureBranch,
        expectedSha: journal.value.featureSha,
      });
      if (!deleted.ok) return deleted.env;
    }
    journal.advance("branch-deleted");
  }

  if (!journal.atLeast("validated")) {
    const validation = validateTeardown({
      worktreePath,
      mainRepoPath: gitRoot,
      featureBranch: state.featureBranch,
      specId,
      checkBranch: state.execution.mode !== "direct",
    });
    if (!validation.ok) {
      return Envelope.fail("run", "finalize-cleanup", "TEARDOWN_VALIDATION_FAILED", validation.reasons);
    }
    journal.advance("validated");
  }

  if (!journal.atLeast("pointer-written")) {
    try {
      deleteRepairBaselineForFlow(gitRoot, state);
      writeLastFinalizedPointer(reportRoot, specId);
    } catch (error) {
      return Envelope.fail(
        "run",
        "finalize-cleanup",
        "FINALIZE_POINTER_WRITE_FAILED",
        `Finalize metadata cleanup failed: ${error.message}`,
        { failureKind: "step-persistence", causeCode: error.code || null },
      );
    }
    journal.advance("pointer-written");
  }

  let pluginLifecycle = { ok: true, warnings: [], issueLogEntries: [], data: {} };
  const savedCompletion = stateOwner.flowManager.readCurrentStepSettlement({
    specId, stepId: "finalize-cleanup", completed: true,
  });
  let settlementReceipt = savedCompletion?.settlement.kind === "completion" ? savedCompletion.receipt : null;
  if (journal.atLeast("completed") && settlementReceipt === null) {
    throw new Error("Completed cleanup journal has no canonical Completion settlement receipt");
  }
  if (!journal.atLeast("completed") && settlementReceipt === null) {
    const pluginContext = ctx.finalizePluginContext || canonicalPluginArtifactContext(finalizeCleanupPrePluginLifecycleContext({
      root: ctx.root,
      state,
      worktreePath,
      mainRepoPath,
      specId,
    }), stateOwner.flowManager, specId);
    const preResult = ctx.finalizePluginPre
      ? { ok: true, pluginPre: ctx.finalizePluginPre }
      : await runFinalizePreHooks(pluginContext, state);
    if (!preResult.ok) return preResult.env;
    const pluginPre = preResult.pluginPre;
    const postResult = await runFinalizePostHooks(
      canonicalPluginArtifactContext(
        finalizeCleanupPluginLifecycleContext({ root: ctx.root, state, worktreePath, mainRepoPath, specId }),
        stateOwner.flowManager,
        specId,
      ),
      state,
      pluginPre,
      Envelope.ok("run", "finalize-cleanup", { status: "done" }),
    );
    if (!postResult.ok) return postResult.env;
    pluginLifecycle = postResult.pluginLifecycle;
    if (!pluginLifecycle.ok) return finalizeRequiredPluginHookFailure(pluginLifecycle);

    recordFinalizeCleanupPostCommandMetadata({
      flowManager: stateOwner.flowManager,
      specId,
      metrics: Array.isArray(state.metrics) ? state.metrics : [],
      runtimeLog: flattenSteps(state.steps || []).find((step) => step.id === "finalize-cleanup")?.runtimeLog || null,
      notes: Array.isArray(state.notes) ? state.notes : [],
      issueLogEntries: pluginLifecycle.issueLogEntries || [],
      pluginArtifacts: pluginLifecycle.data?.pluginHooks || [],
      operationOwnerToken: ctx.repositoryOperationOwnerToken,
    });
    const syncWarning = finalizeSyncWarning(stateOwner.loadReadOnly(), stateOwner.outbox());
    const warned = syncWarning !== null || (pluginLifecycle.warnings || []).length > 0
      || authorization?.route === "forced";
    const completionData = {
      status: "done",
      ...(state.execution.mode === "direct" ? { message: "spec-only mode" } : {}),
      ...(warned ? { outcome: "completed_with_warnings" } : {}),
      ...(syncWarning ? { finalizeWarnings: [syncWarning] } : {}),
      pluginHooks: pluginLifecycle.data?.pluginHooks || [],
      followUps: pluginLifecycle.data?.followUps || [],
      ...(journal.value.rescued === null ? {} : { rescued: journal.value.rescued }),
    };
    const commandResult = Envelope.ok("run", "finalize-cleanup", completionData);
    for (const warning of pluginLifecycle.warnings || []) {
      commandResult.addWarning(warning.code || "PLUGIN_HOOK_WARNING", warning.message || JSON.stringify(warning));
    }
    if (syncWarning) commandResult.addWarning("FINALIZE_SYNC_FAILED",
      `Documentation sync did not complete: ${syncWarning.message}. Run 'sennel flow run sync' after inspecting the recorded diagnostics.`);
    if (authorization !== null) attachForcedFinalizeContext(commandResult, authorization);
    const completionContext = stateOwner.bindContext({
      ...ctx,
      flowState: stateOwner.loadReadOnly(),
      finalizationJournal: journal.value,
      finalizationTeardownAuthorization: authorization,
    });
    const preparation = prepareFinalizationExecution({
      ctx: completionContext, stepId: "finalize-cleanup", commandResult, execution,
    });
    const registration = flowStepExecutionRegistration("finalize-cleanup");
    const selection = registration.executionContract.select({
      ctx: completionContext, stepId: "finalize-cleanup", preparation, registration,
    });
    const outcome = await consumeFinalizationExecution({
      flowManager: stateOwner.flowManager,
      ctx: completionContext, stepId: "finalize-cleanup", preparation, selection, commandResult,
    });
    settlementReceipt = outcome.receipt;
  }
  if (!journal.atLeast("completed")) journal.advance("completed");

  return projectFinalizeCleanupCompletedReceipt({ stateOwner, settlementReceipt });
}

async function runTeardown(ctx, options) {
  return runSharedSpecTeardown(ctx, options);
}

async function runPersistedTeardownIfPresent(ctx, options) {
  const journalPath = requiredSpecLocation(ctx.flowState).artifact("finalize.cleanup.journal");
  return fs.existsSync(journalPath) ? runSharedSpecTeardown(ctx, options) : null;
}

export function commitFinalizeCleanupPostCommandMetadata({ flowManager, specId, writtenPaths = [] } = {}) {
  if (!flowManager) throw new Error("flowManager is required");
  if (!Array.isArray(writtenPaths)) throw new Error("writtenPaths must be an array");
  const specLocation = flowManager.specLocation(specId);
  const repositoryFlowManager = flowManager.forRoot(specLocation.repositoryRoot, { specId });
  const state = repositoryFlowManager.loadReadOnly(specId);
  if (!state) throw new Error(`flow state not found: ${specId}`);
  const root = specLocation.repositoryRoot;
  const identity = finalizationOutboxIdentity(state, "finalize-cleanup");
  const additionalPaths = writtenPaths.map((filePath) => path
    .relative(root, filePath)
    .split(path.sep)
    .join("/"));
  const operation = new RepositoryFlowOperationLock({ mainRoot: root });
  const operationOwnerToken = operation.acquire();
  try {
    const result = commitFinalizeCompletion({
      root,
      repositoryRoot: specLocation.repositoryRoot,
      specRoot: specLocation.relativeRoot,
      specId,
      runId: state.runId,
      idempotencyKey: identity.idempotencyKey,
      additionalPaths,
    });
    repositoryFlowManager.removeActiveFlow(specId, { operationOwnerToken });
    return result;
  } finally {
    operation.release();
  }
}

/** Validate that teardown removed only the selected managed worktree state. */
export { runTeardown };

/**
 * --force teardown variant: persist a FORCED_ORPHAN_DROP audit entry to the
 * main repo issue-log before the existing teardown commits + deletes. The
 * audit entry is staged together with flow.json by runTeardown so the entire
 * destructive action lands in a single commit.
 */
async function runForcedTeardown(ctx, opts) {
  const state = ctx.flowState;
  const { baseline, featureBranch, baseBranch } = opts;
  const droppedCommits = opts.droppedCommits || [];
  const droppedCount = opts.droppedCount ?? droppedCommits.length;
  const droppedTruncated = opts.droppedTruncated ?? false;
  const auditId = finalizeAuditId("forced-orphan-drop", state, {
    baseline,
    featureBranch,
    droppedCommits: droppedCommits.map((commit) => commit.sha),
  });
  const authorization = FinalizeTeardownAuthorization.forced(state, {
    auditId,
    baseline,
    diverged: opts.diverged,
    droppedCommits,
    droppedCount,
    droppedTruncated,
  });
  const teardown = await runSharedSpecTeardown(ctx, { ...opts, authorization });
  if (!teardown.ok) {
    return teardown;
  }

  return teardown;
}

export default RunFinalizeCleanupCommand;
