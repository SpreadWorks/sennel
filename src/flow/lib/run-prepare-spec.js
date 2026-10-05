import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/lib/run-prepare-spec.js
 *
 * FlowCommand: prepare-spec — create branch/worktree and initialize spec directory.
 * requiresFlow: false (this command creates the flow).
 */

import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { isInsideWorktree, PKG_DIR } from "../../lib/cli.js";
import { managedDir, managedOutputDir } from "../../lib/config.js";
import { PRODUCT } from "../../lib/product.js";
import { assertOk, runCmd } from "../../lib/process.js";
import { iterateAnalysisCategories } from "../../docs/lib/analysis-entry.js";
import { GIT_OBJECT_ID, captureGitSnapshot, getWorktreeStatus, runGit } from "../../lib/git-helpers.js";
import { emptySpecStub } from "../../lib/spec-json.js";
import { onHook } from "../../lib/hooks.js";
import { FlowCommand } from "./base-command.js";
import {
  GitHubIssueSnapshotSource,
  IssueSnapshot,
  IssueSnapshotSource,
} from "./issue-snapshot-source.js";
import { discoverFlowCommandHooks, readProjectConfig, runFlowCommandWithPluginLifecycle } from "../../lib/plugin-registry.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowManager } from "../../lib/flow-manager.js";
import { FlowSpecId } from "../../lib/flow-spec-id.js";
import { bindFlowStateLocation } from "../../lib/flow-workspace.js";
import { CanonicalFlowCreateRequest } from "./canonical-flow-manager-store.js";
import { CanonicalFlowArtifactWrite, CurrentFlowSpecRecord } from "./current-flow-state.js";
import { AtomicFile } from "../../lib/atomic-file.js";
import { RepositoryFlowOperationLock } from "../../lib/repository-maintenance-lock.js";
import { ProcessIdentity, ProcessIdentitySource } from "../../lib/process-identity.js";
import { PrepareStepBinding, prepareStepRegistration } from "../engine/composition/prepare.js";
import { PreparationEvidence } from "./preparation-evidence.js";
import { isStepPersistenceFailure } from "./definition-lifecycle-failure.js";
import { isStepAdmissionRefusal } from "./step-admission-refusal.js";
import {
  WorktreeFlowBindingStore,
  WorktreeFlowIdentity,
} from "../../lib/worktree-flow-binding.js";

const MAX_PLUGIN_RUNTIME_SYNC_FILES = 2000;
const REQUIRED_WORKTREE_BRANCH_FILES = Object.freeze([PRODUCT.managedPath("config.json")]);
const MAX_REQUIRED_WORKTREE_BRANCH_FILES = 16;
const WORKTREE_FLOW_INTERNAL_IGNORES = Object.freeze([
  "flow-identity.json",
  ".flow-identity.publication.json",
  ".flow-identity.publication.intent",
  ".flow-identity.publication.receipt.tmp",
  ".flow-identity.publication.binding.tmp",
].map((file) => `/${PRODUCT.managedPath(file)}`));
const WORKTREE_PREPARE_ATTEMPT_FILE = ".worktree-prepare-attempt.json";
const WORKTREE_PREPARE_ATTEMPT_VERSION = 2;
const WORKTREE_PREPARE_ATTEMPT_KEYS = Object.freeze([
  "version",
  "attemptId",
  "mainRoot",
  "runId",
  "issue",
  "request",
  "branchName",
  "worktreePath",
  "specId",
  "expectedOid",
  "preparingPath",
  "preparingBefore",
  "excludePath",
  "excludeBefore",
  "excludeAfter",
  "processIdentity",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_PREPARE_ATTEMPT_BYTES = 256 * 1024;

function reportWorktreePrepareCheckpoint(ctx, phase, attempt) {
  ctx.worktreePrepareFaultInjector?.({
    phase,
    worktreePath: attempt.worktreePath,
    branchName: attempt.branchName,
    specId: attempt.specId,
  });
}

function runGitTrim(root, args) {
  const res = runGit(["-C", root, ...args]);
  if (res.ok) return res.stdout.trim();
  assertOk(res, `git ${args.join(" ")} failed`);
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const SPEC_TAG_LENGTH = 8;

function specTagSource(runId) {
  const compact = runId.replaceAll("-", "").toLowerCase();
  if (/^[0-9a-f]+$/.test(compact) && compact.length >= SPEC_TAG_LENGTH) return compact;
  return crypto.createHash("sha256").update(runId).digest("hex");
}

function isSpecDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function generateSpecIdentity(runId, slug, specsDir, flowManager) {
  const source = specTagSource(runId);
  let available = null;
  for (let offset = 0; offset + SPEC_TAG_LENGTH <= source.length; offset += SPEC_TAG_LENGTH) {
    const tag = source.slice(offset, offset + SPEC_TAG_LENGTH);
    const specId = FlowSpecId.from(`${tag}-${slug}`).toString();
    if (isSpecDirectory(path.join(specsDir, specId))) {
      const state = flowManager.canonicalState(specId);
      if (state?.runId === runId) return { specId,
        branchName: state.execution.featureBranch ?? `feature/${specId}`, state };
    } else if (available === null) {
      available = {
        specId,
        branchName: `feature/${specId}`,
        state: null,
      };
    }
  }
  if (available !== null) return available;
  throw new Error(`runId-derived spec ID candidates are exhausted for ${runId}`);
}

function titleFromSpecId(specId) {
  const separator = specId.indexOf("-");
  return separator < 0 ? specId : specId.slice(separator + 1);
}

function detectBaseBranch(root) {
  try {
    return runGitTrim(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch (e) {
    process.stderr.write(`[sennel] failed to detect current branch, falling back to "main": ${e.message}\n`);
    return "main";
  }
}

export function buildDraftTemplate() {
  return JSON.stringify({
    devType: "",
    goal: "",
    analysis: {
      problem: "",
      proposedApproach: "",
      validation: "",
    },
    decisionMap: {
      knownFacts: [],
      decisionPoints: [],
      resolvedByProjectRules: [],
      requiresUserJudgment: [],
      deferredToSpec: [],
    },
    scopeVerification: {
      in: [],
      out: [],
    },
    impactOnExisting: [],
    // Questions are created only when research leaves a genuine user decision.
    questionLedger: {
      revision: 0,
      publication: "prepare-spec",
      evidenceDigest: "0".repeat(64),
      questions: [],
    },
    openQuestions: [],
  }, null, 2) + "\n";
}

function runDocsScanAndValidate(root) {
  const res = runCmd(process.execPath, [path.join(PKG_DIR, PRODUCT.entrypointBasename), "docs", "scan"], {
    cwd: root,
    timeout: 600000,
    env: { ...process.env, [PRODUCT.env("WORK_ROOT")]: root },
  });
  assertOk(res, "docs scan failed during prepare-spec");
  const analysisPath = path.join(managedOutputDir(root), "analysis.json");
  if (!fs.existsSync(analysisPath)) throw new Error(`analysis.json not found after docs scan: ${analysisPath}`);
  let analysis;
  try {
    analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    [...iterateAnalysisCategories(analysis, { strict: true })];
  } catch (err) {
    throw new Error(`analysis.json is unreadable or invalid after docs scan: ${err.message}`);
  }
}

async function hookSnapshotFor(root) {
  return discoverFlowCommandHooks(root);
}

function executePrepareStepExecution(input) {
  const registration = prepareStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Preparation requires a registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

function replayPrepareStepReceipt(receipt) { return receipt; }

function recoverPrepareStepExecution(input) {
  const registration = prepareStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Preparation recovery requires a registered Step");
  const selection = input.selection;
  if (selection.registration !== registration) throw new TypeError("Preparation recovery requires its selected registration");
  if (selection.receipt !== null) return replayPrepareStepReceipt(selection.receipt);
  return registration.executionContract.execute(selection, { ...input, registration });
}

function acquiredPreparationEvidence({ flowManager, specId, baseOid, worktreePath,
  issueSnapshot, mandatory = null, bindingIdentity = null }) {
  return flowManager.readCanonicalTransitionView({ specId, read: ({ state, activities, catalog }) => (
    new PreparationEvidence({ mode: state.execution.mode, baseOid,
      branch: state.execution.featureBranch, worktree: worktreePath,
      creationActivityId: activities[0].id,
      catalog: catalog.artifacts.filter((entry) => (
        ["spec.record", "spec.snapshot", "issue.snapshot"].includes(entry.logicalKey)
          && entry.activityId === activities[0].id
      )).map((entry) => entry.toJSON()),
      request: state.request, issueSnapshot, mandatory: mandatory === null ? null : {
        plugins: catalog.artifacts.filter((entry) => entry.logicalKey === "plugin.lifecycle.artifact")
          .map((entry) => entry.toJSON()), analysis: mandatory,
      }, bindingIdentity,
    })
  ) });
}

function copyPluginRuntimeDirectory(src, dest, counter = { files: 0 }) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) throw new Error(`plugin runtime sync rejected symlink: ${src}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyPluginRuntimeDirectory(path.join(src, entry), path.join(dest, entry), counter);
    }
    return;
  }
  if (!stat.isFile()) return;
  counter.files += 1;
  if (counter.files > MAX_PLUGIN_RUNTIME_SYNC_FILES) {
    throw new Error(`plugin runtime sync exceeds ${MAX_PLUGIN_RUNTIME_SYNC_FILES} files`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function syncPluginRuntimeToWorktree(root, worktreePath) {
  const config = readProjectConfig(root);
  const sourceManagedDir = managedDir(root);
  const targetManagedDir = managedDir(worktreePath);
  const localConfigPath = path.join(sourceManagedDir, "config.local.json");
  if (fs.existsSync(localConfigPath)) {
    fs.mkdirSync(targetManagedDir, { recursive: true });
    fs.copyFileSync(localConfigPath, path.join(targetManagedDir, "config.local.json"));
  }
  for (const pkg of config.plugin?.packages || []) {
    if (pkg.enabled === false) continue;
    const sourcePluginRoot = path.join(sourceManagedDir, "plugins", pkg.id);
    if (!fs.existsSync(sourcePluginRoot)) continue;
    const targetPluginRoot = path.join(targetManagedDir, "plugins", pkg.id);
    fs.rmSync(targetPluginRoot, { recursive: true, force: true });
    copyPluginRuntimeDirectory(sourcePluginRoot, targetPluginRoot);
  }
}

function gitPathspecStatus(root, relPath) {
  const res = runGit(["-C", root, "status", "--porcelain", "--untracked-files=all", "--", relPath]);
  assertOk(res, `git status failed for ${relPath}`);
  return res.stdout.split(/\r?\n/).filter(Boolean);
}

function branchHasPath(root, ref, relPath) {
  const res = runGit(["-C", root, "cat-file", "-e", `${ref}:${relPath}`]);
  return res.ok;
}

function gitBlobId(root, ref, relPath) {
  const res = runGit(["-C", root, "rev-parse", `${ref}:${relPath}`]);
  return res.ok ? res.stdout.trim() : null;
}

function classifyRequiredBranchFile(root, baseRef, relPath) {
  const lines = gitPathspecStatus(root, relPath);
  const statuses = new Set();
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === "??") {
      statuses.add("untracked");
      continue;
    }
    if (code[0] !== " ") statuses.add("staged");
    if (code[1] !== " ") statuses.add("unstaged");
  }
  if (statuses.size > 0) {
    return {
      ok: false,
      path: relPath,
      status: [...statuses].join("+"),
      reason: `${relPath} has local ${[...statuses].join(" and ")} state that will not be reflected in the new worktree checkout from ${baseRef}.`,
    };
  }
  if (!branchHasPath(root, baseRef, relPath)) {
    return {
      ok: false,
      path: relPath,
      status: "missing",
      reason: `${relPath} is not present in ${baseRef}, so the new worktree checkout will not contain the required config file.`,
    };
  }
  const currentBlob = gitBlobId(root, "HEAD", relPath);
  const baseBlob = gitBlobId(root, baseRef, relPath);
  if (currentBlob && baseBlob && currentBlob !== baseBlob) {
    return {
      ok: false,
      path: relPath,
      status: "base-mismatch",
      reason: `${relPath} content in HEAD differs from ${baseRef}, so the new worktree checkout from ${baseRef} will use stale required config content that is not reflected from the current branch.`,
    };
  }
  return { ok: true, path: relPath };
}

function checkRequiredWorktreeBranchFiles(root, baseRef) {
  if (REQUIRED_WORKTREE_BRANCH_FILES.length > MAX_REQUIRED_WORKTREE_BRANCH_FILES) {
    throw new Error(`required worktree branch file list exceeds ${MAX_REQUIRED_WORKTREE_BRANCH_FILES} entries`);
  }
  const issues = [];
  for (const relPath of REQUIRED_WORKTREE_BRANCH_FILES) {
    const result = classifyRequiredBranchFile(root, baseRef, relPath);
    if (!result.ok) issues.push(result);
  }
  return issues;
}

function requiredWorktreeFilesEnvelope(issues) {
  const paths = issues.map((issue) => `${issue.path} (${issue.status})`).join(", ");
  return Envelope.fail("run", "prepare-spec", "REQUIRED_WORKTREE_FILES_UNREFLECTED", [
    `Required worktree branch files are not reflected in the source branch: ${paths}.`,
    "Commit the required file changes and continue/resume this flow prepare, or abort flow prepare.",
    "The preflight stopped before prepare-state cleanup, git worktree add, feature branch creation, spec files, flow state, docs scan, and config copying side effects.",
  ], {
    requiredFiles: issues,
    recoveryOptions: ["commit-and-continue", "abort"],
    choices: [
      { id: "commit-and-continue", label: "Commit required files and continue" },
      { id: "abort", label: "Abort flow prepare" },
    ],
  });
}

function gitWorktreeRecord(root, worktreePath) {
  const listed = runGit(["-C", root, "worktree", "list", "--porcelain"]);
  assertOk(listed, "git worktree list failed during prepare rollback");
  const expectedPath = path.resolve(worktreePath);
  for (const block of listed.stdout.trim().split(/\n\n+/)) {
    const fields = Object.fromEntries(block.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (fields.worktree && path.resolve(fields.worktree) === expectedPath) return fields;
  }
  return null;
}

function gitRefOid(root, branchName) {
  const result = runGit(["-C", root, "rev-parse", "--verify", `refs/heads/${branchName}`]);
  return result.ok ? result.stdout.trim() : null;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function optionalBytes(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function rollbackRequiredPrepareHookFailure(specDir, createdSourceFiles) {
  // Fresh V1 publication is one atomic directory rename.  Required-hook
  // rollback therefore owns the entire Version root rather than attempting
  // to reconstruct a partially written root-file list.
  fs.rmSync(specDir, { recursive: true, force: true });
  fsyncDirectory(path.dirname(specDir));
}

function encodedBytes(bytes) {
  return bytes == null ? null : bytes.toString("base64");
}

function decodedBytes(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64 or null`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} must be canonical base64`);
  return bytes;
}

function worktreeIgnoreBytes(before) {
  const current = before?.toString("utf8") || "";
  const existing = new Set(current.split(/\r?\n/));
  const missing = WORKTREE_FLOW_INTERNAL_IGNORES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return Buffer.from(current);
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  return Buffer.from(`${current}${separator}${missing.join("\n")}\n`);
}

class WorktreePrepareAttemptRecord {
  constructor(value) {
    exactKeys(value, WORKTREE_PREPARE_ATTEMPT_KEYS, "worktree prepare attempt");
    if (value.version !== WORKTREE_PREPARE_ATTEMPT_VERSION || !UUID.test(value.attemptId)) {
      throw new Error("worktree prepare attempt version or ID is invalid");
    }
    if (!path.isAbsolute(value.mainRoot) || fs.realpathSync(value.mainRoot) !== value.mainRoot) {
      throw new Error("worktree prepare attempt main root is invalid");
    }
    if (!path.isAbsolute(value.worktreePath) || path.resolve(value.worktreePath) !== value.worktreePath) {
      throw new Error("worktree prepare attempt worktree path is invalid");
    }
    FlowSpecId.from(value.specId);
    if (!GIT_OBJECT_ID.test(value.expectedOid)) {
      throw new Error("worktree prepare attempt expected OID is invalid");
    }
    if (!SAFE_RUN_ID.test(value.runId) || value.branchName !== `feature/${value.specId}`) {
      throw new Error("worktree prepare attempt run or branch is invalid");
    }
    if (value.issue !== null && (!Number.isSafeInteger(value.issue) || value.issue < 1)) {
      throw new Error("worktree prepare attempt Issue is invalid");
    }
    if (typeof value.request !== "string") {
      throw new Error("worktree prepare attempt request is invalid");
    }
    for (const [filePath, label] of [
      [value.preparingPath, "preparing path"],
      [value.excludePath, "exclude path"],
    ]) {
      if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
        throw new Error(`worktree prepare attempt ${label} is invalid`);
      }
    }
    const expectedWorktreePath = path.join(
      managedDir(value.mainRoot),
      "worktree",
      value.branchName.replace(/\//g, "-"),
    );
    if (value.worktreePath !== expectedWorktreePath) {
      throw new Error("worktree prepare attempt managed path is invalid");
    }
    if (value.preparingPath !== path.join(managedDir(value.mainRoot), `.active-flow.${value.runId}`)) {
      throw new Error("worktree prepare attempt preparing path is invalid");
    }
    const rawExclude = runGitTrim(value.mainRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const expectedExcludePath = path.isAbsolute(rawExclude)
      ? rawExclude
      : path.resolve(value.mainRoot, rawExclude);
    if (value.excludePath !== expectedExcludePath) {
      throw new Error("worktree prepare attempt exclude path is invalid");
    }
    this.version = value.version;
    this.attemptId = value.attemptId;
    this.mainRoot = value.mainRoot;
    this.runId = value.runId;
    this.issue = value.issue;
    this.request = value.request;
    this.branchName = value.branchName;
    this.worktreePath = value.worktreePath;
    this.specId = value.specId;
    this.expectedOid = value.expectedOid;
    this.preparingPath = value.preparingPath;
    this.preparingBefore = decodedBytes(value.preparingBefore, "preparing before-image");
    this.excludePath = value.excludePath;
    this.excludeBefore = decodedBytes(value.excludeBefore, "exclude before-image");
    this.excludeAfter = decodedBytes(value.excludeAfter, "exclude after-image");
    this.processIdentity = new ProcessIdentity(value.processIdentity);
    if (this.processIdentity.ownerToken !== this.attemptId) {
      throw new Error("worktree prepare attempt process owner token is invalid");
    }
    Object.freeze(this);
  }

  static create({ mainRoot, runId, issue, request, branchName, worktreePath, specId, expectedOid, processIdentitySource }) {
    const attemptId = crypto.randomUUID();
    const preparingPath = path.join(managedDir(mainRoot), `.active-flow.${runId}`);
    const rawExclude = runGitTrim(mainRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = path.isAbsolute(rawExclude) ? rawExclude : path.resolve(mainRoot, rawExclude);
    const preparingBefore = optionalBytes(preparingPath);
    const excludeBefore = optionalBytes(excludePath);
    return new WorktreePrepareAttemptRecord({
      version: WORKTREE_PREPARE_ATTEMPT_VERSION,
      attemptId,
      mainRoot,
      runId,
      issue,
      request,
      branchName,
      worktreePath,
      specId,
      expectedOid,
      preparingPath,
      preparingBefore: encodedBytes(preparingBefore),
      excludePath,
      excludeBefore: encodedBytes(excludeBefore),
      excludeAfter: encodedBytes(worktreeIgnoreBytes(excludeBefore)),
      processIdentity: processIdentitySource.createOwner(attemptId),
    });
  }

  toJSON() {
    return {
      version: this.version,
      attemptId: this.attemptId,
      mainRoot: this.mainRoot,
      runId: this.runId,
      issue: this.issue,
      request: this.request,
      branchName: this.branchName,
      worktreePath: this.worktreePath,
      specId: this.specId,
      expectedOid: this.expectedOid,
      preparingPath: this.preparingPath,
      preparingBefore: encodedBytes(this.preparingBefore),
      excludePath: this.excludePath,
      excludeBefore: encodedBytes(this.excludeBefore),
      excludeAfter: encodedBytes(this.excludeAfter),
      processIdentity: this.processIdentity,
    };
  }
}

class WorktreePrepareAttemptJournal {
  constructor({ mainRoot, processIdentitySource = new ProcessIdentitySource() }) {
    this.mainRoot = fs.realpathSync(mainRoot);
    this.path = path.join(managedDir(this.mainRoot), WORKTREE_PREPARE_ATTEMPT_FILE);
    this.processIdentitySource = processIdentitySource;
  }

  load() {
    let stat;
    try {
      stat = fs.lstatSync(this.path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.size > MAX_PREPARE_ATTEMPT_BYTES
      || fs.realpathSync(this.path) !== this.path
    ) {
      throw new Error("worktree prepare attempt journal authority is invalid");
    }
    let descriptor = null;
    try {
      descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) {
        throw new Error("worktree prepare attempt journal changed while opening");
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      const visible = fs.lstatSync(this.path);
      if (
        after.dev !== opened.dev
        || after.ino !== opened.ino
        || visible.dev !== opened.dev
        || visible.ino !== opened.ino
        || after.nlink !== 1
        || visible.nlink !== 1
        || after.size !== bytes.length
      ) {
        throw new Error("worktree prepare attempt journal changed while reading");
      }
      const record = new WorktreePrepareAttemptRecord(JSON.parse(bytes.toString("utf8")));
      if (record.mainRoot !== this.mainRoot) throw new Error("worktree prepare attempt root mismatch");
      return { record, stat: opened };
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }

  begin(record, flowManager) {
    if (!(record instanceof WorktreePrepareAttemptRecord)) {
      throw new Error("worktree prepare attempt record is required");
    }
    if (this.load()) throw new Error("worktree prepare attempt already exists");
    if (gitWorktreeRecord(this.mainRoot, record.worktreePath) || fs.existsSync(record.worktreePath)) {
      throw new Error("worktree prepare attempt path already exists before journal publication");
    }
    if (gitRefOid(this.mainRoot, record.branchName) != null) {
      throw new Error("worktree prepare attempt branch already exists before journal publication");
    }
    if (fs.existsSync(flowManager.specLocation(record.specId).directory)) {
      throw new Error("worktree prepare spec directory exists before journal publication");
    }
    if (flowManager.loadActiveFlows().some((entry) => entry.specId === record.specId)) {
      throw new Error("worktree prepare active-flow entry exists before journal publication");
    }
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    new AtomicFile(this.path).write(`${JSON.stringify(record.toJSON(), null, 2)}\n`);
    const published = this.load();
    if (published.record.attemptId !== record.attemptId) {
      throw new Error("worktree prepare attempt journal readback mismatch");
    }
    return record;
  }

  recoverStale(flowManager, operationLock, confirmedReceipt = null, branchReceipt = null) {
    const snapshot = this.load();
    if (!snapshot) return null;
    const operationOwnerToken = operationLock.assertOwned();
    const assessment = this.processIdentitySource.assess(snapshot.record.processIdentity);
    if (assessment.status !== "stale") {
      throw new Error(`worktree prepare attempt owner is ${assessment.status}: ${assessment.reason}`);
    }
    if (confirmedReceipt !== null) {
      const record = snapshot.record;
      if (confirmedReceipt.binding.runId !== record.runId
        || confirmedReceipt.binding.specId !== record.specId
        || confirmedReceipt.binding.stepId !== "prepare-spec"
        || confirmedReceipt.preparation.worktree !== record.worktreePath
        || confirmedReceipt.preparation.baseOid !== record.expectedOid) {
        throw new Error("confirmed preparation does not match the journal owner");
      }
      this.#validateRollback(record, flowManager);
      this.complete(record);
      return null;
    }
    if (branchReceipt !== null) {
      const record = snapshot.record;
      const evidence = branchReceipt.preparation;
      if (branchReceipt.binding.runId !== record.runId || branchReceipt.binding.specId !== record.specId
        || branchReceipt.binding.stepId !== "branch" || branchReceipt.targetStepId !== "prepare-spec"
        || evidence.mode !== "worktree" || evidence.branch !== record.branchName
        || evidence.worktree !== record.worktreePath || evidence.baseOid !== record.expectedOid
        || evidence.request !== record.request || (evidence.issueSnapshot?.number ?? null) !== record.issue) {
        throw new Error("confirmed branch preparation does not match the journal owner");
      }
      this.#validateRollback(record, flowManager);
      this.assertGitCreated(record);
      const adopted = new WorktreePrepareAttemptRecord({
        ...record.toJSON(), processIdentity: this.processIdentitySource.createOwner(record.attemptId),
      });
      new AtomicFile(this.path, { commitGuard: () => {
        operationLock.assertOwned();
        const current = this.load();
        if (current === null || current.stat.dev !== snapshot.stat.dev || current.stat.ino !== snapshot.stat.ino
          || JSON.stringify(current.record.toJSON()) !== JSON.stringify(record.toJSON())) {
          throw new Error("worktree prepare journal owner changed before branch recovery");
        }
      } }).write(`${JSON.stringify(adopted.toJSON(), null, 2)}\n`);
      const published = this.load();
      if (JSON.stringify(published?.record.toJSON()) !== JSON.stringify(adopted.toJSON())) {
        throw new Error("worktree prepare branch recovery ownership readback mismatch");
      }
      return adopted;
    }
    this.rollback(snapshot.record, flowManager, operationOwnerToken);
    return null;
  }

  assertGitCreated(record) {
    const worktree = gitWorktreeRecord(this.mainRoot, record.worktreePath);
    const branchOid = gitRefOid(this.mainRoot, record.branchName);
    if (
      worktree?.HEAD !== record.expectedOid
      || worktree.branch !== `refs/heads/${record.branchName}`
      || branchOid !== record.expectedOid
    ) {
      throw new Error("created worktree and branch do not match the prepare attempt authority");
    }
  }

  publishExclude(record, worktreePath) {
    const rawPath = runGitTrim(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(worktreePath, rawPath);
    if (excludePath !== record.excludePath) throw new Error("worktree exclude authority path changed");
    const current = optionalBytes(excludePath);
    if (!this.#sameBytes(current, record.excludeBefore)) {
      throw new Error("shared worktree exclude changed before attempt publication");
    }
    if (this.#sameBytes(current, record.excludeAfter)) return;
    new AtomicFile(excludePath).write(record.excludeAfter);
  }

  rollback(record, flowManager, operationOwnerToken) {
    const authority = this.#validateRollback(record, flowManager);
    if (authority.registryOwned) {
      flowManager.removeActiveFlow(record.specId, { operationOwnerToken });
    }
    if (authority.preparingMissing && record.preparingBefore != null) {
      new AtomicFile(record.preparingPath).write(record.preparingBefore);
    }
    if (authority.excludePublished) {
      if (record.excludeBefore == null) {
        fs.unlinkSync(record.excludePath);
        fsyncDirectory(path.dirname(record.excludePath));
      } else {
        new AtomicFile(record.excludePath).write(record.excludeBefore);
      }
    }
    if (authority.specDirectoryOwned) {
      fs.rmSync(authority.specDirectory, { recursive: true });
      fsyncDirectory(path.dirname(authority.specDirectory));
    }
    if (authority.worktree) {
      const removed = runGit(["-C", this.mainRoot, "worktree", "remove", "--force", record.worktreePath]);
      if (!removed.ok) throw new Error(`git worktree remove failed: ${removed.stderr.trim()}`);
    }
    const branchOid = gitRefOid(this.mainRoot, record.branchName);
    if (branchOid === record.expectedOid) {
      const removed = runGit([
        "-C", this.mainRoot, "update-ref", "-d", `refs/heads/${record.branchName}`, record.expectedOid,
      ]);
      if (!removed.ok) throw new Error(`git branch CAS delete failed: ${removed.stderr.trim()}`);
    }
    this.#remove(record);
  }

  complete(record) {
    const snapshot = this.load();
    if (!snapshot || snapshot.record.attemptId !== record.attemptId) {
      throw new Error("worktree prepare attempt journal ownership changed before completion");
    }
    this.#remove(record);
  }

  #validateRollback(record, flowManager) {
    const snapshot = this.load();
    if (!snapshot || snapshot.record.attemptId !== record.attemptId) {
      throw new Error("worktree prepare attempt journal ownership changed before rollback");
    }
    const matches = flowManager.loadActiveFlows().filter((entry) => entry.specId === record.specId);
    if (matches.length > 1 || (matches.length === 1 && matches[0].mode !== "worktree")) {
      throw new Error("active-flow authority changed before prepare attempt rollback");
    }
    const preparing = optionalBytes(record.preparingPath);
    if (preparing != null && !this.#sameBytes(preparing, record.preparingBefore)) {
      throw new Error("preparing flow authority changed before prepare attempt rollback");
    }
    const exclude = optionalBytes(record.excludePath);
    const excludePublished = this.#sameBytes(exclude, record.excludeAfter)
      && !this.#sameBytes(exclude, record.excludeBefore);
    if (!excludePublished && !this.#sameBytes(exclude, record.excludeBefore)) {
      throw new Error("shared worktree exclude authority changed before prepare attempt rollback");
    }
    const worktree = gitWorktreeRecord(this.mainRoot, record.worktreePath);
    const branchOid = gitRefOid(this.mainRoot, record.branchName);
    if (worktree && (
      worktree.HEAD !== record.expectedOid
      || worktree.branch !== `refs/heads/${record.branchName}`
      || branchOid !== record.expectedOid
    )) {
      throw new Error("worktree prepare attempt Git authority changed from expected OID");
    }
    if (!worktree && fs.existsSync(record.worktreePath)) {
      throw new Error("worktree prepare attempt path exists outside Git authority");
    }
    if (!worktree && branchOid != null && branchOid !== record.expectedOid) {
      throw new Error("worktree prepare attempt branch authority changed from expected OID");
    }
    const specDirectory = flowManager.specLocation(record.specId).directory;
    const flowPath = flowManager.pathFor(record.specId);
    const flowBytes = optionalBytes(flowPath);
    if (flowBytes != null) {
      const flow = JSON.parse(flowBytes.toString("utf8"));
      if (
        flow.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION
        ||
        flow.runId !== record.runId
        || flow.specId !== record.specId
        || flow.execution?.mode !== "worktree"
      ) {
        throw new Error("worktree prepare flow authority changed before rollback");
      }
    }
    if (worktree) {
      const bindingPath = path.join(record.worktreePath, PRODUCT.managedPath("flow-identity.json"));
      const bindingBytes = optionalBytes(bindingPath);
      if (bindingBytes != null) {
        const binding = JSON.parse(bindingBytes.toString("utf8"));
        if (
          binding.runId !== record.runId
          || binding.issue !== record.issue
          || binding.specId !== record.specId
          || binding.worktreePath !== record.worktreePath
        ) {
          throw new Error("worktree prepare binding authority changed before rollback");
        }
      }
    }
    return {
      registryOwned: matches.length === 1,
      preparingMissing: preparing == null,
      excludePublished,
      specDirectory,
      specDirectoryOwned: fs.existsSync(specDirectory),
      worktree,
    };
  }

  #remove(record) {
    const snapshot = this.load();
    if (!snapshot || snapshot.record.attemptId !== record.attemptId) {
      throw new Error("worktree prepare attempt journal changed before removal");
    }
    const current = fs.lstatSync(this.path);
    if (current.dev !== snapshot.stat.dev || current.ino !== snapshot.stat.ino || current.nlink !== 1) {
      throw new Error("worktree prepare attempt journal inode CAS failed");
    }
    fs.unlinkSync(this.path);
    fsyncDirectory(path.dirname(this.path));
  }

  #sameBytes(left, right) {
    return left === null || right === null ? left === right : left.equals(right);
  }
}

function ensureWorktreeFlowIdentityIgnored(worktreePath, journal, record) {
  if (journal && record) return journal.publishExclude(record, worktreePath);
  const rawPath = runGitTrim(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(worktreePath, rawPath);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const existing = new Set(current.split(/\r?\n/));
  const missing = WORKTREE_FLOW_INTERNAL_IGNORES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  new AtomicFile(excludePath).write(`${current}${separator}${missing.join("\n")}\n`);
}

export class RunPrepareSpecCommand extends FlowCommand {
  constructor({ issueSnapshotSource = new GitHubIssueSnapshotSource() } = {}) {
    super({ requiresFlow: false });
    if (!(issueSnapshotSource instanceof IssueSnapshotSource)) {
      throw new TypeError("issueSnapshotSource must be an IssueSnapshotSource");
    }
    this.issueSnapshotSource = issueSnapshotSource;
  }

  async execute(ctx) {
    const { root, flowManager } = ctx;
    const currentExecutionRoot = fs.realpathSync(ctx.executionRoot || root);

    let title = ctx.title || "";
    const base = ctx.base || "";
    const runIdArg = ctx.runId || "";
    const noBranch = ctx.noBranch || false;
    const useWorktreeFlag = ctx.worktree || false;
    const dryRun = ctx.dryRun || false;

    const mainRoot = fs.realpathSync(ctx.mainRoot || flowManager._mainRoot || root);
    const priorIdentity = runIdArg && title ? generateSpecIdentity(runIdArg, slugify(title) || "feature",
      (ctx.specRoot ?? flowManager.specRoot).resolve(mainRoot), flowManager) : null;
    const priorState = priorIdentity?.state ?? null;
    const retryJournal = !dryRun && runIdArg && useWorktreeFlag
      ? new WorktreePrepareAttemptJournal({
          mainRoot,
          processIdentitySource: ctx.worktreePrepareProcessIdentitySource,
        })
      : null;
    const retryAttempt = retryJournal?.load()?.record ?? null;
    const preparingState = runIdArg ? flowManager.loadPreparingFlow(runIdArg) : null;
    let issue;
    let request;
    if (preparingState) {
      ({ issue, request } = flowManager.resolvePreparingInputs(runIdArg, ctx.issue, ctx.request));
    } else if (retryAttempt?.runId === runIdArg) {
      if (ctx.issue != null && Number(ctx.issue) !== retryAttempt.issue) {
        throw new Error("stale worktree prepare attempt Issue does not match this exact retry target");
      }
      if (ctx.request && ctx.request !== retryAttempt.request) {
        throw new Error("stale worktree prepare attempt request does not match this exact retry target");
      }
      issue = retryAttempt.issue;
      request = retryAttempt.request;
    } else if (priorState !== null) {
      if (ctx.issue != null && Number(ctx.issue) !== priorState.identity.issue) {
        throw new Error("completed preparation Issue does not match this exact retry target");
      }
      if (ctx.request != null && ctx.request !== priorState.request) {
        throw new Error("completed preparation request does not match this exact retry target");
      }
      issue = priorState.identity.issue;
      request = priorState.request;
    } else {
      ({ issue, request } = flowManager.resolvePreparingInputs(runIdArg, ctx.issue, ctx.request));
    }
    if (retryAttempt?.runId === runIdArg && !title) {
      title = titleFromSpecId(retryAttempt.specId);
    }
    if (ctx.flowState && !runIdArg) {
      return Envelope.fail(
        "run",
        "prepare-spec",
        "TARGET_REQUIRED",
        "Cannot run bare prepare while another flow is active; run `sennel flow set init` and pass the returned --run-id.",
        {
          active: {
            runId: ctx.flowState.runId || null,
            issue: ctx.flowState.issue || null,
            specId: ctx.flowState.specId || null,
          },
        },
      );
    }
    if (ctx.flowState && runIdArg && ctx.flowState.runId !== runIdArg) {
      return Envelope.fail(
        "run",
        "prepare-spec",
        "ACTIVE_FLOW_MISMATCH",
        "prepare --run-id did not resolve to an isolated preparing flow; target selection would use another active flow.",
        {
          active: {
            runId: ctx.flowState.runId || null,
            issue: ctx.flowState.issue || null,
            specId: ctx.flowState.specId || null,
          },
          requested: {
            runId: runIdArg,
            issue: preparingState?.issue || null,
          },
        },
      );
    }

    if (!title) {
      throw new Error("--title is required");
    }

    let resolvedIssueSnapshot = null;
    if (!dryRun && issue) {
      const completedBranch = priorState === null ? null : flowManager.readCurrentStepSettlement({
        specId: priorState.specId, stepId: "branch", completed: true,
      });
      const cached = completedBranch?.receipt.preparation.issueSnapshot?.body ?? preparingState?.issueBody;
      if (typeof cached === "string") {
        resolvedIssueSnapshot = new IssueSnapshot({ number: Number(issue), body: cached });
      } else {
        const snapshot = this.issueSnapshotSource.load({ number: Number(issue), root: mainRoot });
        if (snapshot === null) {
          return Envelope.fail(
            "run",
            "prepare-spec",
            "ISSUE_SNAPSHOT_UNAVAILABLE",
            `cannot prepare linked Issue #${issue}: its immutable Issue snapshot could not be retrieved`,
          );
        }
        if (!(snapshot instanceof IssueSnapshot)) {
          throw new TypeError("issueSnapshotSource must return an IssueSnapshot or null");
        }
        resolvedIssueSnapshot = snapshot.assertIdentity(Number(issue));
      }
    }

    const config = ctx.config;
    if (!config) {
      throw new Error("config.json not found");
    }
    const resolvedBase = base || detectBaseBranch(currentExecutionRoot);
    const baseOid = runGitTrim(currentExecutionRoot, ["rev-parse", resolvedBase]);

    // Determine branching strategy
    const inWorktree = isInsideWorktree(currentExecutionRoot);
    const skipBranch = noBranch || inWorktree;
    const useWorktree = !skipBranch && useWorktreeFlag;

    const slug = slugify(title) || "feature";
    const attemptJournal = !dryRun && useWorktree
      ? retryJournal ?? new WorktreePrepareAttemptJournal({ mainRoot, processIdentitySource: ctx.worktreePrepareProcessIdentitySource })
      : null;
    const pendingAttempt = retryAttempt ?? attemptJournal?.load()?.record ?? null;
    if (pendingAttempt && (
      (!runIdArg || pendingAttempt.runId !== runIdArg)
      || pendingAttempt.issue !== (issue ? Number(issue) : null)
      || pendingAttempt.request !== request
      || !pendingAttempt.specId.endsWith(`-${slug}`)
    )) {
      throw new Error("stale worktree prepare attempt does not match this exact retry target");
    }
    if (pendingAttempt && baseOid !== pendingAttempt.expectedOid) {
      throw new Error("stale worktree prepare attempt base revision does not match this exact retry target");
    }
    const flowRunId = runIdArg || pendingAttempt?.runId || flowManager.generateRunId();
    const identity = pendingAttempt
      ? { specId: pendingAttempt.specId, branchName: pendingAttempt.branchName }
      : priorIdentity ?? generateSpecIdentity(
          flowRunId,
          slug,
          (ctx.specRoot ?? flowManager.specRoot).resolve(mainRoot),
          flowManager,
        );
    const { branchName, specId } = identity;

    // Determine where spec files live
    const worktreePath = useWorktree
      ? path.join(managedDir(root), "worktree", branchName.replace(/\//g, "-"))
      : null;
    const executionRoot = useWorktree ? worktreePath : currentExecutionRoot;
    const specLocation = flowManager.specLocation(specId);
    const specDir = specLocation.directory;
    const mode = useWorktree ? "worktree" : skipBranch ? "direct" : "branch";
    if (priorState !== null && (priorState.execution.mode !== mode
      || priorState.context.toJSON()?.baseOid !== baseOid)) {
      throw new Error("saved preparation mode or base revision does not match this exact retry target");
    }

    if (!dryRun && useWorktree) {
      const requiredFileIssues = checkRequiredWorktreeBranchFiles(currentExecutionRoot, baseOid);
      if (requiredFileIssues.length > 0) {
        return requiredWorktreeFilesEnvelope(requiredFileIssues);
      }
    }

    if (dryRun) {
      const mode = useWorktree ? "worktree" : skipBranch ? "direct" : "branch";
      return {
        result: "dry-run",
        changed: [],
        artifacts: { specDir: specLocation.relativeDirectory, branch: branchName, worktree: worktreePath, mode },
        next: null,
        output: [
          `[dry-run] mode: ${mode}`,
          `[dry-run] base: ${resolvedBase}`,
          `[dry-run] branch: ${branchName}`,
          `[dry-run] spec dir: ${specLocation.relativeDirectory}`,
        ].join("\n"),
      };
    }

    const operationLock = new RepositoryFlowOperationLock({
      mainRoot,
      ...(ctx.worktreePrepareProcessIdentitySource && {
        processIdentitySource: ctx.worktreePrepareProcessIdentitySource,
      }),
    });
    const operationOwnerToken = operationLock.acquire();
    try {
    // A branch-mode prepare must reject a competing active branch flow before
    // reporting incidental checkout dirtiness. Keep both checks under the
    // repository operation lock so the registry authority cannot change
    // between preflight and `git checkout -b`.
    if (!skipBranch && !useWorktree) {
      flowManager.cleanStaleFlows({ operationOwnerToken });
      flowManager.assertCanAddActiveFlow(specId, "branch", { operationOwnerToken });
      const { dirty, dirtyFiles } = getWorktreeStatus(currentExecutionRoot);
      const operationLockRelativePath = path.relative(
        currentExecutionRoot,
        operationLock.lockPath,
      ).split(path.sep).join("/");
      const blockingDirtyFiles = dirtyFiles.filter((file) => {
        const rel = file.replace(/^[ AMDRCU?!]{2}\s+/, "");
        return !rel.startsWith(".tmp/") && rel !== operationLockRelativePath;
      });
      if (dirty && blockingDirtyFiles.length > 0) {
        throw new Error(`dirty worktree: ${blockingDirtyFiles.join(", ")}. commit/stash before spec, or use --worktree to isolate.`);
      }
    }
    const completedPreparation = priorState === null ? null : flowManager.readCurrentStepSettlement({
      specId, stepId: "prepare-spec", completed: true,
    });
    const completedBranch = priorState === null ? null : flowManager.readCurrentStepSettlement({
      specId, stepId: "branch", completed: true,
    });
    const resumedWorktreeAttempt = attemptJournal?.recoverStale(flowManager, operationLock,
      completedPreparation?.receipt ?? null, completedBranch?.receipt ?? null) ?? null;

    // The Version Store atomically creates spec.json, flow.json, the ledger,
    // catalog, and an optional Issue snapshot together.  No root-level
    // pre-write is permitted: a failed prepare must never expose a partial
    // Flow identity or a spec without its state authority.
    function freshSpecRecord() {
      return new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        tasks: [],
      }, { specId });
    }

    let canonicalManager = null;
    function preparationManager() {
      return canonicalManager ??= flowManager.forRoot(executionRoot, { specId });
    }
    const issueEvidence = resolvedIssueSnapshot;
    let preparationConfirmed = false;

    async function adoptPreparation(stepId, mandatory = null, bindingIdentity = null) {
      const preparation = acquiredPreparationEvidence({ flowManager: preparationManager(), specId,
        baseOid, worktreePath, issueSnapshot: issueEvidence, mandatory, bindingIdentity });
      const saved = preparationManager().readCurrentStepSettlement({ specId, stepId, completed: true });
      if (saved !== null) {
        if (JSON.stringify(saved.receipt.preparation.toJSON()) !== JSON.stringify(preparation.toJSON())) {
          throw new Error("saved preparation evidence differs from this exact retry target");
        }
        const input = { flowManager: preparationManager(), specId, stepId, receipt: saved.receipt };
        const registration = prepareStepRegistration(stepId);
        const selection = registration.executionContract.select({ ...input, registration });
        return recoverPrepareStepExecution({ ...input, selection });
      }
      preparationManager().beginNextAction(specId);
      const binding = new PrepareStepBinding({ flowManager: preparationManager(), specId, stepId });
      const outcome = await executePrepareStepExecution({ flowManager: preparationManager(),
        specId, stepId, binding, preparation,
        commandResult: { runId: flowRunId, specId, stepId, preparation: preparation.toJSON() } });
      return outcome.receipt;
    }

    async function writeFlowState() {
      if (!fs.existsSync(preparationManager().pathFor(specId))) {
        preparationManager().createFresh(new CanonicalFlowCreateRequest({
          specId, runId: flowRunId, request: request ?? "",
          execution: { mode, baseBranch: resolvedBase, featureBranch: skipBranch ? null : branchName },
          policy: { autoApprove: preparingState?.autoApprove === true, nonblocking: null },
          issue: issue ? Number(issue) : null,
          flowId: `flow-${flowRunId}`, flowVersionId: `flow-v1-${flowRunId}`,
          context: { baseOid, gitSnapshot: captureGitSnapshot(executionRoot) },
          specRecord: freshSpecRecord(), issueSnapshot: resolvedIssueSnapshot?.body ?? null,
        }));
      }
      const preparationReceipt = await adoptPreparation("branch");
      const hooks = await hookSnapshotFor(executionRoot);
      const state = flowManager.forRoot(mainRoot, { specId }).loadReadOnly(specId);
      state.plugins = { flowCommandHooks: hooks };
      const lifecycle = await runFlowCommandWithPluginLifecycle(executionRoot, hooks, {
        command: "prepare", flow: { ...state, specRoot: specLocation.specRoot },
        artifactRepositoryRoot: mainRoot,
        main: async () => ({ ok: true, data: { issue: state.issue, specId, runId: flowRunId } }),
      });
      const pluginArtifactWrites = lifecycle.data?.pluginArtifactWrites || [];
      preparationManager().publishPluginArtifacts({ specId, preparationReceipt,
        artifactWrites: pluginArtifactWrites.map((write) => new CanonicalFlowArtifactWrite(write)) });
      if (!lifecycle.ok) {
        rollbackRequiredPrepareHookFailure(specDir);
        const error = new Error(lifecycle.outcome?.failure?.message || "required prepare hook failed");
        error.code = "PLUGIN_HOOK_REQUIRED_FAILED";
        error.pluginLifecycle = lifecycle;
        throw error;
      }
    }

    async function completePreparation(bindingIdentity = null) {
      const bytes = fs.readFileSync(path.join(managedOutputDir(executionRoot), "analysis.json"));
      await adoptPreparation("prepare-spec", {
        hash: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
      }, bindingIdentity);
      preparationConfirmed = true;
    }

    const changed = [
      specLocation.relativeArtifact("flow.state"),
      specLocation.relativeArtifact("flow.activities"),
      specLocation.relativeArtifact("spec.record"),
      specLocation.relativeArtifact("artifact.catalog"),
      ...(issue ? [specLocation.relativeArtifact("issue.snapshot")] : []),
    ];
    const createdFileLines = [
      `created canonical Flow: ${specLocation.relativeArtifact("flow.state")}`,
      `created spec source: ${specLocation.relativeArtifact("spec.record")}`,
    ];
    const fillAndGateNext = [
      `fill ${specLocation.relativeArtifact("draft")}`,
      `run: sennel flow run gate --phase draft`,
      `start implementation`,
    ];
    const lines = [];

    if (completedPreparation !== null) {
      const saved = completedPreparation.receipt.preparation;
      await adoptPreparation("prepare-spec", saved.mandatory.analysis, saved.bindingIdentity);
      preparationConfirmed = true;
      lines.push("reused canonical preparation receipt", ...createdFileLines);
      if (runIdArg && flowManager.loadPreparingFlow(runIdArg) !== null) {
        flowManager.deletePreparingFlow(runIdArg, { operationOwnerToken });
      }
    } else if (useWorktree) {
      let worktreeAttempt = resumedWorktreeAttempt;
      let attemptPublished = resumedWorktreeAttempt !== null;
      try {
        if (worktreeAttempt === null) {
          worktreeAttempt = WorktreePrepareAttemptRecord.create({
            mainRoot,
            runId: flowRunId,
            issue: issue ? Number(issue) : null,
            request,
            branchName,
            worktreePath,
            specId,
            expectedOid: baseOid,
            processIdentitySource: attemptJournal.processIdentitySource,
          });
          attemptJournal.begin(worktreeAttempt, flowManager);
          attemptPublished = true;
          reportWorktreePrepareCheckpoint(ctx, "after-journal-publication", worktreeAttempt);
          runGitTrim(mainRoot, ["worktree", "add", worktreePath, "-b", branchName, baseOid]);
          attemptJournal.assertGitCreated(worktreeAttempt);
          reportWorktreePrepareCheckpoint(ctx, "after-worktree-add", worktreeAttempt);
          ensureWorktreeFlowIdentityIgnored(worktreePath, attemptJournal, worktreeAttempt);
          reportWorktreePrepareCheckpoint(ctx, "after-exclusion-registration", worktreeAttempt);
          syncPluginRuntimeToWorktree(currentExecutionRoot, worktreePath);
          await onHook("PostWorktree", { CWD: worktreePath });
        }
        await writeFlowState();
        reportWorktreePrepareCheckpoint(ctx, "after-planning-state-publication", worktreeAttempt);
        runDocsScanAndValidate(executionRoot);
        const identity = new WorktreeFlowIdentity({
          runId: flowRunId,
          issue: issue ? Number(issue) : null,
          specId,
          worktreePath,
        });
        new WorktreeFlowBindingStore({
          worktreePath,
          faultInjector: ctx.worktreeFlowBindingFaultInjector,
        }).save(identity);
        reportWorktreePrepareCheckpoint(ctx, "after-identity-binding", worktreeAttempt);
        const worktreeManager = flowManager.forRoot(worktreePath, {
          bindingFaultInjector: ctx.worktreeFlowBindingFaultInjector,
        });
        const resolvedIdentity = worktreeManager.resolveWorktreeBinding();
        if (!resolvedIdentity.equals(identity)) {
          throw new Error("fresh worktree manager resolved a different flow binding");
        }
        resolvedIdentity.assertFlowState(worktreeManager.load(resolvedIdentity.specId));
        flowManager.cleanStaleFlows({ operationOwnerToken });
        flowManager.addActiveFlow(specId, "worktree", { operationOwnerToken });
        reportWorktreePrepareCheckpoint(ctx, "after-registry-publication", worktreeAttempt);
        await completePreparation(identity.toJSON());
        if (runIdArg) flowManager.deletePreparingFlow(runIdArg, { operationOwnerToken });
        reportWorktreePrepareCheckpoint(ctx, "after-preparing-flow-removal", worktreeAttempt);
        attemptJournal.complete(worktreeAttempt);
        reportWorktreePrepareCheckpoint(ctx, "after-journal-completion", worktreeAttempt);
        attemptPublished = false;
      } catch (publicationError) {
        let preservePublication = preparationConfirmed
          || (resumedWorktreeAttempt !== null && isStepAdmissionRefusal(publicationError));
        if (!preservePublication && isStepPersistenceFailure(publicationError)) {
          try {
            const state = preparationManager().canonicalState(specId);
            preservePublication = ["branch", "prepare-spec"].some((stepId) => (
              state?.findNode(stepId).result?.draftSettlementReceipt != null
            ));
          } catch {
            // An uncertain durable publication must remain available to its
            // journal owner; rollback cannot prove it is uncommitted.
            preservePublication = true;
          }
        }
        if (attemptPublished && !preservePublication) {
          try {
            attemptJournal.rollback(worktreeAttempt, flowManager, operationOwnerToken);
          } catch (rollbackError) {
            throw new AggregateError(
              [publicationError, rollbackError],
              "worktree publication and attempt rollback both failed",
              { cause: publicationError },
            );
          }
        }
        throw publicationError;
      }
      lines.push(
        `created worktree: ${worktreePath}`,
        `created branch: ${branchName} (from ${resolvedBase})`,
        ...createdFileLines,
        "",
        "next:",
        `1) cd ${worktreePath}`,
        ...fillAndGateNext.map((l, i) => `${i + 2}) ${l}`),
      );
    } else if (skipBranch) {
      flowManager.cleanStaleFlows({ operationOwnerToken });
      await writeFlowState();
      runDocsScanAndValidate(executionRoot);
      flowManager.addActiveFlow(specId, "direct", { operationOwnerToken });
      await completePreparation();
      lines.push(
        ...createdFileLines,
        "",
        "next:",
        ...fillAndGateNext.map((l, i) => `${i + 1}) ${l}`),
      );
    } else {
      if (priorState === null) runGitTrim(currentExecutionRoot, ["checkout", "-b", branchName, baseOid]);
      else if (runGitTrim(currentExecutionRoot, ["rev-parse", "HEAD"]) !== baseOid
        || runGitTrim(currentExecutionRoot, ["symbolic-ref", "--short", "HEAD"]) !== branchName) {
        throw new Error("saved branch preparation Git authority differs from this retry target");
      }
      await writeFlowState();
      runDocsScanAndValidate(executionRoot);
      flowManager.addActiveFlow(specId, "branch", { operationOwnerToken });
      await completePreparation();
      lines.push(
        `created branch: ${branchName} (from ${resolvedBase})`,
        ...createdFileLines,
        "",
        "next:",
        ...fillAndGateNext.map((l, i) => `${i + 1}) ${l}`),
      );
    }

    if (runIdArg && !useWorktree && flowManager.loadPreparingFlow(runIdArg) !== null) {
      flowManager.deletePreparingFlow(runIdArg, { operationOwnerToken });
    }

    return {
      result: "ok",
      runId: flowRunId,
      issue: issue ? Number(issue) : null,
      specId,
      worktreePath,
      changed,
      artifacts: {
        specDir: specLocation.relativeDirectory,
        branch: branchName,
        worktree: worktreePath,
        mode: useWorktree ? "worktree" : (skipBranch ? "direct" : "branch"),
      },
      next: "draft",
      output: lines.join("\n"),
    };
    } catch (error) {
      if (error.code === "PLUGIN_HOOK_REQUIRED_FAILED" && error.pluginLifecycle) {
        return Envelope.fail(
          "run",
          "prepare-spec",
          error.code,
          error.message,
          { pluginLifecycle: error.pluginLifecycle },
        );
      }
      throw error;
    } finally {
      operationLock.release();
    }
  }
}

export default RunPrepareSpecCommand;
