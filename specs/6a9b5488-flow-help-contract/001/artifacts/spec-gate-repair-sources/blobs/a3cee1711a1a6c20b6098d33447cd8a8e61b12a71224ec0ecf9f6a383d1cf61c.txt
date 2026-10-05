/**
 * Transient input/output work unit for one canonical review Attempt.
 *
 * The parent creates this contract from canonical state.  The worker may only
 * consume its declared inputs and seal its one declared output.  A recovered
 * worker manifest is evidence, never authority: the parent compares it with
 * the contract it has just reconstructed from the active Attempt.
 */

import fs from "node:fs";
import path from "node:path";

import { AtomicFile } from "../../lib/atomic-file.js";
import { PRODUCT } from "../../lib/product.js";
import { captureRegularFile } from "../../lib/regular-file-snapshot.js";
import { FlowArtifactAttemptHistory } from "../../lib/flow-artifact-contract.js";
import { CanonicalSpecReview, SpecReviewDelta, mergeSpecReviewDelta } from "./spec-review-artifacts.js";
import { readTaskReviewAbortedWorkUnit } from "./task-review-aborted-work-unit.js";
import {
  MAX_UNTRUSTED_WORK_UNIT_FILE_BYTES, requiredText, digest, stableJson, logicalPath,
  ReviewWorkUnitTarget, ReviewWorkUnitOutput, ReviewWorkUnitInput,
  ReviewWorkUnitManifest, ReviewWorkUnitSeal, ReviewWorkUnitOutputReceipt,
} from "./review-work-unit-values.js";

export const REVIEW_WORK_UNIT_MANIFEST_ENV = PRODUCT.env("REVIEW_WORK_UNIT_MANIFEST");
const REVIEW_WORK_UNIT_ROOT = PRODUCT.managedPath("review-work-units");

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ensureRealDirectory(directory, boundary) {
  const target = path.resolve(directory);
  const root = path.resolve(boundary);
  if (target !== root && !isWithin(root, target)) throw new Error("review work unit directory escapes execution authority");
  const parent = path.dirname(target);
  if (target !== root) ensureRealDirectory(parent, root);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o755 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) {
    throw new Error("review work unit directory must be a real directory");
  }
  return target;
}

function regularFile(file, label, maxBytes = MAX_UNTRUSTED_WORK_UNIT_FILE_BYTES) {
  try {
    return captureRegularFile(file, { label, maxBytes });
  } catch (cause) {
    throw new Error(`${label} is unavailable or invalid: ${cause.message}`);
  }
}

export function assertReviewWorkUnitInputSnapshot(input, root) {
  const source = path.resolve(root, input.relativePath);
  if (!isWithin(root, source)) throw new Error("review work unit input escapes its directory");
  const snapshot = regularFile(source, `review work unit input ${input.logicalKey}`, input.byteLength);
  if (snapshot.digest !== input.digest || snapshot.byteLength !== input.byteLength) {
    throw new Error(`review work unit input ${input.logicalKey} changed after manifest finalization`);
  }
  return snapshot;
}

/** A parent-created execution work unit whose manifest is the child contract. */
export class ReviewWorkUnit {
  constructor({ executionRoot, runId, specId, phase, taskId = null, nodeId, attemptId, target, output } = {}) {
    const execution = requiredText(executionRoot, "review executionRoot");
    if (!path.isAbsolute(execution)) throw new Error("review executionRoot must be absolute");
    this.executionRoot = path.resolve(execution);
    this.runId = requiredText(runId, "review work unit runId");
    this.specId = requiredText(specId, "review work unit specId");
    this.phase = requiredText(phase, "review work unit phase");
    this.taskId = taskId === null ? null : requiredText(taskId, "review work unit taskId");
    this.nodeId = requiredText(nodeId, "review work unit nodeId");
    this.attemptId = requiredText(attemptId, "review work unit attemptId");
    this.target = target instanceof ReviewWorkUnitTarget ? target : new ReviewWorkUnitTarget(target);
    this.output = output instanceof ReviewWorkUnitOutput ? output : new ReviewWorkUnitOutput(output);
    this.root = path.join(
      this.executionRoot,
      REVIEW_WORK_UNIT_ROOT,
      digest(this.specId).slice(0, 24),
      digest(this.runId).slice(0, 24),
      digest(`${this.nodeId}:${this.attemptId}`).slice(0, 32),
    );
    this.inputs = [];
    this.manifestDocument = null;
  }

  prepare() {
    ensureRealDirectory(this.root, this.executionRoot);
    ensureRealDirectory(path.join(this.root, "inputs"), this.root);
    return this;
  }

  get directory() { return this.root; }
  get manifestPath() { return path.join(this.root, "manifest.json"); }
  get sealPath() { return path.join(this.root, "seal.json"); }
  outputPath() { return path.join(this.root, this.output.basename); }

  declareInput({ logicalKey, logicalPath: name, bytes, mediaType = "application/octet-stream", root = false } = {}) {
    if (this.manifestDocument !== null) throw new Error("review work unit inputs are immutable after manifest finalization");
    const key = requiredText(logicalKey, "review work unit input logicalKey");
    const relative = logicalPath(name, "review work unit input logicalPath");
    const value = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
    const entry = new ReviewWorkUnitInput({
      logicalKey: key,
      logicalPath: relative,
      relativePath: root ? relative : path.posix.join("inputs", relative),
      digest: digest(value),
      byteLength: value.length,
      mediaType: requiredText(mediaType, "review work unit input mediaType"),
    });
    const existing = this.inputs.find((candidate) => (
      candidate.logicalKey === entry.logicalKey && candidate.relativePath === entry.relativePath
    ));
    if (existing) {
      if (stableJson(existing.toJSON()) !== stableJson(entry.toJSON())) {
        throw new Error(`review work unit input ${entry.logicalKey} was declared inconsistently`);
      }
      return existing;
    }
    this.inputs.push(entry);
    return entry;
  }

  writeInput(value = {}) {
    this.prepare();
    const entry = this.declareInput(value);
    const target = path.resolve(this.root, entry.relativePath);
    if (!isWithin(this.root, target)) throw new Error("review work unit input escapes its directory");
    ensureRealDirectory(path.dirname(target), this.root);
    new AtomicFile(target, { phaseNamespace: "review-work-unit-input" }).write(Buffer.from(value.bytes));
    return Object.freeze({ sourcePath: target, digest: entry.digest, byteLength: entry.byteLength });
  }

  manifest() {
    return this.manifestDocument || new ReviewWorkUnitManifest({
      version: 1,
      runId: this.runId,
      specId: this.specId,
      phase: this.phase,
      taskId: this.taskId,
      nodeId: this.nodeId,
      attemptId: this.attemptId,
      target: this.target.toJSON(),
      inputs: this.inputs.map((input) => input.toJSON()),
      output: this.output.toJSON(),
    });
  }

  finalize() {
    this.prepare();
    this.manifestDocument = this.manifest();
    new AtomicFile(this.manifestPath, { phaseNamespace: "review-work-unit-manifest" })
      .write(Buffer.from(`${JSON.stringify(this.manifestDocument.toJSON(), null, 2)}\n`, "utf8"));
    return Object.freeze({ manifest: this.manifestDocument, manifestPath: this.manifestPath, directory: this.root, outputPath: this.outputPath() });
  }

  recoverSealed() {
    const hasManifest = fs.existsSync(this.manifestPath);
    const hasSeal = fs.existsSync(this.sealPath);
    if (!hasManifest && !hasSeal) return null;
    if (!hasManifest || !hasSeal) {
      this.cleanup();
      return null;
    }
    const worker = ReviewWorkUnit.fromEnvironment(
      { [REVIEW_WORK_UNIT_MANIFEST_ENV]: this.manifestPath },
      { expectedManifest: this.manifest(), expectedDirectory: this.root },
    );
    worker.readSealedOutput();
    return worker;
  }

  /**
   * Return an active unsealed worker surface without deleting it.  Task
   * Review uses this only to fail closed after an interrupted provider call;
   * reconciliation remains the owner of later cleanup.
   */
  recoverUnsealed() {
    const hasManifest = fs.existsSync(this.manifestPath);
    const hasSeal = fs.existsSync(this.sealPath);
    if (!hasManifest && !hasSeal) return null;
    if (!hasManifest) throw new Error("review work unit seal exists without its manifest");
    if (hasSeal) return null;
    return ReviewWorkUnit.fromEnvironment(
      { [REVIEW_WORK_UNIT_MANIFEST_ENV]: this.manifestPath },
      { expectedManifest: this.manifest(), expectedDirectory: this.root },
    );
  }

  cleanup() {
    if (!fs.existsSync(this.root)) return false;
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.root) !== this.root) {
      throw new Error("review work unit cleanup target is invalid");
    }
    fs.rmSync(this.root, { recursive: true });
    return true;
  }

  static fromEnvironment(environment = process.env, { expectedManifest = null, expectedDirectory = null } = {}) {
    const manifestPath = requiredText(environment[REVIEW_WORK_UNIT_MANIFEST_ENV], REVIEW_WORK_UNIT_MANIFEST_ENV);
    if (!path.isAbsolute(manifestPath) || path.basename(manifestPath) !== "manifest.json") {
      throw new Error(`${REVIEW_WORK_UNIT_MANIFEST_ENV} must be an absolute manifest path`);
    }
    const directory = path.dirname(manifestPath);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      throw new Error("review worker manifest directory must be a real directory");
    }
    const snapshot = regularFile(manifestPath, "review work unit manifest");
    let manifest;
    try { manifest = new ReviewWorkUnitManifest(JSON.parse(snapshot.bytes.toString("utf8"))); }
    catch (cause) { throw new Error(`review work unit manifest is invalid: ${cause.message}`); }
    if (expectedDirectory !== null && path.resolve(expectedDirectory) !== directory) {
      throw new Error("review worker manifest is outside the parent execution work unit");
    }
    if (expectedManifest !== null) manifest.assertBinding(expectedManifest);
    const instance = Object.create(ReviewWorkUnit.prototype);
    instance.root = directory;
    instance.manifestDocument = manifest;
    instance.manifestDigest = snapshot.digest;
    return instance;
  }

  assertOutputDirectory(directory) {
    if (path.resolve(directory) !== this.root) throw new Error("review output directory does not match its work unit manifest");
    return this;
  }

  seal() {
    if (!(this.manifestDocument instanceof ReviewWorkUnitManifest)) throw new Error("only a worker manifest may be sealed");
    for (const input of this.manifestDocument.inputs) assertReviewWorkUnitInputSnapshot(input, this.root);
    const output = regularFile(path.join(this.root, this.manifestDocument.output.basename), "review work unit output");
    const seal = ReviewWorkUnitSeal.forManifest(this.manifestDocument, output);
    new AtomicFile(path.join(this.root, "seal.json"), { phaseNamespace: "review-work-unit-seal" })
      .write(Buffer.from(`${JSON.stringify(seal.toJSON(), null, 2)}\n`, "utf8"));
    return seal;
  }

  readSealedOutput() {
    if (!(this.manifestDocument instanceof ReviewWorkUnitManifest)) throw new Error("review work unit manifest is required");
    const sealSnapshot = regularFile(path.join(this.root, "seal.json"), "review work unit seal");
    let seal;
    try { seal = new ReviewWorkUnitSeal(JSON.parse(sealSnapshot.bytes.toString("utf8"))); }
    catch (cause) { throw new Error(`review work unit seal is invalid: ${cause.message}`); }
    seal.assertManifest(this.manifestDocument);
    for (const input of this.manifestDocument.inputs) assertReviewWorkUnitInputSnapshot(input, this.root);
    const output = regularFile(path.join(this.root, this.manifestDocument.output.basename), "sealed review work unit output");
    if (seal.output.digest !== output.digest || seal.output.byteLength !== output.byteLength) {
      throw new Error("sealed review work unit output changed after sealing");
    }
    return Object.freeze({ bytes: output.bytes, output: this.manifestDocument.output, seal });
  }
}

function expectedNodeForManifest(manifest) {
  if (manifest.phase === "draft-questions" || manifest.phase === "draft-coverage") return `${manifest.phase}-review`;
  if (manifest.phase === "spec" || manifest.phase === "test") return `${manifest.phase}-review`;
  if (manifest.phase === "impl") return manifest.taskId === null ? "impl-review" : `${manifest.taskId}-review`;
  throw new Error("review work unit manifest phase is not recognized");
}

function safeDirectoryEntries(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error("review work unit reconciliation directory is not real");
  }
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("review work unit reconciliation found an unknown namespace entry");
    }
    return path.join(directory, entry.name);
  });
}

function descriptorSnapshot(flowManager, specId, descriptor) {
  const location = flowManager.specLocation(specId);
  const snapshot = regularFile(location.resolve(descriptor.relativePath), "canonical review receipt artifact");
  if (snapshot.digest !== descriptor.hash || snapshot.byteLength !== descriptor.size) {
    throw new Error("canonical review receipt descriptor does not match its artifact bytes");
  }
  return snapshot;
}

function matchesDraftReviewExecution(activity, manifest, phase, executionGeneration = null) {
  const lifecycle = activity.result?.draftSettlementReceipt?.executionLifecycle ?? null;
  const binding = lifecycle?.binding ?? null;
  return lifecycle?.phase === phase
    && binding?.kind === "review"
    && Number.isSafeInteger(binding.executionGeneration)
    && (executionGeneration === null || binding.executionGeneration === executionGeneration)
    && binding.manifestDigest === manifest.digest
    && binding.inputDigest === manifest.inputDigest
    && binding.target?.treeSha === manifest.target.treeSha
    && binding.target?.targetStateDigest === manifest.target.targetStateDigest;
}

function confirmedReviewReceipt(flowManager, specId, workUnit, sealed, { catalog, activities }) {
  const manifest = workUnit.manifestDocument;
  const seal = sealed.seal;
  const draftExecution = manifest.phase === "draft-questions" || manifest.phase === "draft-coverage";
  const candidates = activities.filter((candidate) => (
    candidate.type === "result_confirmed"
    && candidate.nodeId === manifest.nodeId
    && candidate.attemptId === manifest.attemptId
  ));
  const activity = candidates.findLast((candidate) => (
    (!draftExecution || matchesDraftReviewExecution(candidate, manifest, "terminal"))
    && catalog.artifacts.some((entry) => (
      entry.logicalKey === (manifest.phase === "spec" ? manifest.output.logicalKey : "review.evidence")
      && entry.activityId === candidate.id
    ))
  )) ?? null;
  if (activity === null) return false;
  if (manifest.phase === "spec") {
    const outputDescriptor = catalog.artifacts.find((entry) => (
      entry.logicalKey === "spec.review" && entry.activityId === activity.id
    )) ?? null;
    const reviewInput = manifest.inputs.filter((input) => input.logicalKey === "spec.review");
    if (outputDescriptor === null || outputDescriptor.mediaType !== manifest.output.mediaType
      || reviewInput.length !== 1 || activity.reviewPublication === null
      || activity.reviewPublication.stage !== "spec-review") return false;
    let inputReview;
    let publishedReview;
    let delta;
    try {
      inputReview = new CanonicalSpecReview(JSON.parse(
        assertReviewWorkUnitInputSnapshot(reviewInput[0], workUnit.directory).bytes.toString("utf8"),
      ));
      publishedReview = new CanonicalSpecReview(JSON.parse(
        descriptorSnapshot(flowManager, specId, outputDescriptor).bytes.toString("utf8"),
      ));
      delta = new SpecReviewDelta(JSON.parse(sealed.bytes.toString("utf8")));
      delta.assertCurrent(inputReview);
      if (delta.stage !== "spec-review") return false;
      activity.reviewPublication.assertReview(publishedReview, {
        specId,
        revision: publishedReview.identity.revision.value,
        bytes: descriptorSnapshot(flowManager, specId, outputDescriptor).bytes,
      });
    } catch {
      return false;
    }
    try {
      return mergeSpecReviewDelta({ review: inputReview, delta }).digest === publishedReview.digest;
    } catch {
      return false;
    }
  }
  const evidenceDescriptor = catalog.artifacts.find((entry) => (
    entry.logicalKey === "review.evidence" && entry.activityId === activity.id
  )) ?? null;
  const publicationActivity = draftExecution
    ? candidates.findLast((candidate) => matchesDraftReviewExecution(
      candidate,
      manifest,
      "publication",
      activity.result.draftSettlementReceipt.executionLifecycle.binding.executionGeneration,
    )) ?? null
    : activity;
  if (publicationActivity === null) return false;
  const outputDescriptor = catalog.artifacts.find((entry) => (
    entry.logicalKey === manifest.output.logicalKey
    && entry.activityId === publicationActivity.id
  )) ?? null;
  if (evidenceDescriptor === null || outputDescriptor === null || outputDescriptor.mediaType !== manifest.output.mediaType) return false;
  let evidence;
  let history;
  try {
    evidence = JSON.parse(descriptorSnapshot(flowManager, specId, evidenceDescriptor).bytes.toString("utf8"));
    history = FlowArtifactAttemptHistory.fromJSON(JSON.parse(
      descriptorSnapshot(flowManager, specId, outputDescriptor).bytes.toString("utf8"),
    ));
  } catch {
    return false;
  }
  const record = history.attempts.find((entry) => entry.attempt.value === activity.sequence) ?? null;
  let outputReceipt = null;
  try {
    outputReceipt = new ReviewWorkUnitOutputReceipt(record?.payload?.artifact?.payload?.workerOutput);
  } catch {
    return false;
  }
  return evidence?.phase === manifest.phase
    && (evidence?.taskId ?? null) === manifest.taskId
    && evidence?.treeSha === manifest.target.treeSha
    && evidence?.targetStateDigest === manifest.target.targetStateDigest
    && outputReceipt.equals(new ReviewWorkUnitOutputReceipt({
      digest: seal.output.digest,
      byteLength: seal.output.byteLength,
      mediaType: manifest.output.mediaType,
    }));
}

function hasAuthorizedTaskReviewSuccessor({ activities, archive }) {
  const failureIndex = activities.findIndex((activity) => (
    activity.transition?.operation === "fail_attempt"
    && activity.nodeId === archive.nodeId
    && activity.attemptId === archive.attempt.id
    && activity.sequence === archive.attempt.sequence
    && activity.failure?.category === "tooling"
  ));
  if (failureIndex < 0) return false;
  return activities.some((activity, index) => {
    if (index <= failureIndex) return false;
    const replacement = activity.transition?.attempt ?? null;
    if (!(["retry_attempt", "retry_recovery_attempt"].includes(activity.transition?.operation))
      || activity.nodeId !== archive.nodeId
      || replacement?.nodeId !== archive.nodeId
      || replacement.sequence <= archive.attempt.sequence) return false;
    if (activity.transition.operation === "retry_attempt") {
      return activity.attemptId === archive.attempt.id && activity.sequence === archive.attempt.sequence;
    }
    const predecessor = [...activities.slice(0, index)].reverse().find((candidate) => (
      candidate.transition?.operation === "fail_attempt" && candidate.nodeId === archive.nodeId
    )) ?? null;
    return predecessor?.attemptId === archive.attempt.id && predecessor.sequence === archive.attempt.sequence;
  });
}

export function reviewWorkUnitNamespace({ executionRoot, specId, runId }) {
  return path.join(
    path.resolve(requiredText(executionRoot, "review work unit executionRoot")),
    REVIEW_WORK_UNIT_ROOT,
    digest(requiredText(specId, "review work unit specId")).slice(0, 24),
    digest(requiredText(runId, "review work unit runId")).slice(0, 24),
  );
}

function assertTaskReviewWorkUnitIdentity({ worker, directory, runId, specId, taskId, nodeId, acceptedAttemptIds }) {
  const manifest = worker.manifestDocument;
  if (
    manifest.runId !== runId
    || manifest.specId !== specId
    || manifest.phase !== "impl"
    || manifest.taskId !== taskId
    || manifest.nodeId !== nodeId
    || !(acceptedAttemptIds instanceof Set)
    || !acceptedAttemptIds.has(manifest.attemptId)
    || path.basename(directory) !== digest(`${manifest.nodeId}:${manifest.attemptId}`).slice(0, 32)
    || !manifest.output.equals(ReviewWorkUnitOutput.forReview({ phase: "impl", taskId }))
  ) {
    throw new Error("Task Review unsealed work unit identity does not match its execution namespace");
  }
  return worker;
}

/** All retained unsealed Task Review surfaces for one current task/node identity. */
export class TaskReviewUnsealedWorkUnitSet {
  constructor({ runId, specId, taskId, nodeId, acceptedAttemptIds, workUnits = [] } = {}) {
    this.runId = requiredText(runId, "Task Review unsealed work unit runId");
    this.specId = requiredText(specId, "Task Review unsealed work unit specId");
    this.taskId = requiredText(taskId, "Task Review unsealed work unit taskId");
    this.nodeId = requiredText(nodeId, "Task Review unsealed work unit nodeId");
    if (!(acceptedAttemptIds instanceof Set) || acceptedAttemptIds.size === 0) {
      throw new Error("Task Review unsealed work unit set requires canonical Attempt identities");
    }
    this.acceptedAttemptIds = new Set(acceptedAttemptIds);
    if (!Array.isArray(workUnits) || workUnits.some((worker) => !(worker instanceof ReviewWorkUnit))) {
      throw new Error("Task Review unsealed work unit set requires recovered work units");
    }
    for (const worker of workUnits) {
      assertTaskReviewWorkUnitIdentity({
        worker,
        directory: worker.root,
        runId: this.runId,
        specId: this.specId,
        taskId: this.taskId,
        nodeId: this.nodeId,
        acceptedAttemptIds: this.acceptedAttemptIds,
      });
    }
    this.workUnits = Object.freeze([...workUnits]);
    Object.freeze(this);
  }

  static recover({ executionRoot, runId, specId, taskId, nodeId, acceptedAttemptIds } = {}) {
    const namespace = reviewWorkUnitNamespace({ executionRoot, runId, specId });
    if (!fs.existsSync(namespace)) {
      return new TaskReviewUnsealedWorkUnitSet({ runId, specId, taskId, nodeId, acceptedAttemptIds });
    }
    const recovered = [];
    for (const directory of safeDirectoryEntries(namespace)) {
      const manifestPath = path.join(directory, "manifest.json");
      const sealPath = path.join(directory, "seal.json");
      if (!fs.existsSync(manifestPath) || fs.existsSync(sealPath)) continue;
      const worker = ReviewWorkUnit.fromEnvironment(
        { [REVIEW_WORK_UNIT_MANIFEST_ENV]: manifestPath },
        { expectedDirectory: directory },
      );
      const manifest = worker.manifestDocument;
      if (manifest.phase !== "impl" || manifest.taskId !== taskId) continue;
      recovered.push(assertTaskReviewWorkUnitIdentity({
        worker,
        directory,
        runId,
        specId,
        taskId,
        nodeId,
        acceptedAttemptIds,
      }));
    }
    return new TaskReviewUnsealedWorkUnitSet({
      runId,
      specId,
      taskId,
      nodeId,
      acceptedAttemptIds,
      workUnits: recovered,
    });
  }

  static recoverCanonical({ executionRoot, state, activities, taskId, nodeId } = {}) {
    if (state === null || typeof state !== "object" || !Array.isArray(activities)) {
      throw new Error("Task Review unsealed work unit recovery requires canonical state and activities");
    }
    return TaskReviewUnsealedWorkUnitSet.recover({
      executionRoot,
      runId: state.runId,
      specId: state.specId,
      taskId,
      nodeId,
      acceptedAttemptIds: canonicalTaskReviewAttemptIds({ state, nodeId, activities }),
    });
  }
}

function canonicalTaskReviewAttemptIds({ state, nodeId, activities }) {
  const attemptIds = new Set();
  if (state.attempt?.nodeId === nodeId && typeof state.attempt.id === "string" && state.attempt.id !== "") {
    attemptIds.add(state.attempt.id);
  }
  for (const activity of activities) {
    if (activity?.nodeId === nodeId && typeof activity.attemptId === "string" && activity.attemptId !== "") {
      attemptIds.add(activity.attemptId);
    }
  }
  return attemptIds;
}

function confirmedTaskReviewUnavailable({ worker, activities }) {
  const manifest = worker.manifestDocument;
  return activities.some((activity) => {
    const plan = activity.transition?.taskReviewStagePlan ?? null;
    const facts = plan?.facts ?? null;
    return plan?.operation === "review-unavailable-to-gate"
      && activity.nodeId === manifest.nodeId
      && activity.attemptId === manifest.attemptId
      && facts?.binding?.attemptId === manifest.attemptId
      && facts?.unavailable?.workUnitManifestDigest === manifest.digest;
  });
}

/**
 * Dispatcher-start reconciliation for a process crash after Store confirmation
 * but before local cleanup. The worker manifest chooses no authority here: it
 * is only a locator which must match a canonical Activity and evidence receipt.
 */
export function reconcileCompletedReviewWorkUnits({ flowManager, specId, executionRoot } = {}) {
  if (!flowManager || typeof flowManager.readCanonicalTransitionView !== "function") {
    throw new Error("review work unit reconciliation requires a lock-scoped FlowManager view");
  }
  const reconcile = ({ state, catalog, activities }) => {
    if (state === null) throw new Error("review work unit reconciliation requires a Version-1 Flow state");
    const root = reviewWorkUnitNamespace({ executionRoot, specId, runId: state.runId });
    if (!fs.existsSync(root)) return 0;
    let cleaned = 0;
    for (const directory of safeDirectoryEntries(root)) {
      const manifestPath = path.join(directory, "manifest.json");
      const sealPath = path.join(directory, "seal.json");
      if (!fs.existsSync(manifestPath) || !fs.existsSync(sealPath)) {
        // A concurrent dispatcher may reconcile while the direct Review
        // provider is still writing its exact active Attempt work unit.
        const activeNodeId = state.current?.at(-1) ?? null;
        if (activeNodeId !== null && state.attempt !== null
          && path.basename(directory) === digest(`${activeNodeId}:${state.attempt.id}`).slice(0, 32)) {
          continue;
        }
        if (fs.existsSync(manifestPath) && !fs.existsSync(sealPath)) {
          const worker = ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: manifestPath }, { expectedDirectory: directory });
          const manifest = worker.manifestDocument;
          if (manifest.phase === "impl" && manifest.taskId !== null) {
            assertTaskReviewWorkUnitIdentity({
              worker,
              directory,
              runId: state.runId,
              specId,
              taskId: manifest.taskId,
              nodeId: expectedNodeForManifest(manifest),
              acceptedAttemptIds: canonicalTaskReviewAttemptIds({
                state,
                nodeId: expectedNodeForManifest(manifest),
                activities,
              }),
            });
            if (confirmedTaskReviewUnavailable({ worker, activities })) {
              worker.cleanup();
              cleaned += 1;
            }
            continue;
          }
        }
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
          throw new Error("unsealed review work unit cleanup target is invalid");
        }
        fs.rmSync(directory, { recursive: true });
        cleaned += 1;
        continue;
      }
      const worker = ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: manifestPath }, { expectedDirectory: directory });
      const manifest = worker.manifestDocument;
      if (
        manifest.specId !== specId
        || manifest.runId !== state.runId
        || manifest.nodeId !== expectedNodeForManifest(manifest)
        || path.basename(directory) !== digest(`${manifest.nodeId}:${manifest.attemptId}`).slice(0, 32)
        || !manifest.output.equals(ReviewWorkUnitOutput.forReview({ phase: manifest.phase, taskId: manifest.taskId }))
      ) throw new Error("review work unit reconciliation identity does not match its execution namespace");
      const sealed = worker.readSealedOutput();
      if (confirmedReviewReceipt(flowManager, specId, worker, sealed, { catalog, activities })) {
        worker.cleanup();
        cleaned += 1;
        continue;
      }
      const activeAttempt = state.attempt ?? null;
      if (state.current?.at(-1) === manifest.nodeId && activeAttempt?.id === manifest.attemptId) continue;
      if (manifest.phase === "impl" && manifest.taskId !== null) {
        const archived = readTaskReviewAbortedWorkUnit({ flowManager, state, worker, catalog, activities });
        if (archived !== null && hasAuthorizedTaskReviewSuccessor({ activities, archive: archived })) {
          worker.cleanup();
          cleaned += 1;
          continue;
        }
      }
      throw new Error("sealed review work unit has no canonical confirmation receipt or active Attempt");
    }
    return cleaned;
  };
  return flowManager.readCanonicalTransitionView({
    specId,
    read: (view) => reconcile({ state: view.state, catalog: view.catalog, activities: view.activities }),
  });
}
