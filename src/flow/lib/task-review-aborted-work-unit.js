import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { CanonicalFlowArtifactWrite, CurrentAttemptIdentity } from "./current-flow-state.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
  ReviewWorkUnitManifest,
  ReviewWorkUnitSeal,
  reviewWorkUnitNamespace,
} from "./review-work-unit.js";

export const TASK_REVIEW_ABORTED_WORK_UNIT_KEY = "task.review.aborted.work-unit";

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function base64(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be base64 text`);
  return value;
}

function digest(value, field) {
  const resolved = text(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(resolved)) throw new Error(`${field} must be a SHA-256 digest`);
  return resolved;
}

function exact(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${field} has an invalid schema`);
  }
  return value;
}

function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function exactToolingFailure(activities, manifest) {
  const matched = activities.filter((activity) => (
    activity.transition?.operation === "fail_attempt"
    && activity.nodeId === manifest.nodeId
    && activity.attemptId === manifest.attemptId
  ));
  if (matched.length !== 1 || matched[0].failure?.category !== "tooling") {
    throw new Error("sealed Task Review work unit has no exact tooling failure Activity");
  }
  return matched[0];
}

/** Durable archive of a sealed, unpublished Task Review worker result.
 *
 * This is failure evidence, never a producer result.  Its bytes cannot be
 * promoted or reused by a replacement Attempt.
 */
export class TaskReviewAbortedWorkUnit {
  constructor(value = {}) {
    exact(value, ["version", "runId", "specId", "taskId", "nodeId", "attempt", "manifest", "manifestDigest", "seal", "inputs", "output", "digest"], "Task Review aborted work unit");
    if (value.version !== 1) throw new Error("Task Review aborted work unit version is invalid");
    this.version = 1;
    this.runId = text(value.runId, "Task Review aborted work unit runId");
    this.specId = text(value.specId, "Task Review aborted work unit specId");
    this.taskId = text(value.taskId, "Task Review aborted work unit taskId");
    this.nodeId = text(value.nodeId, "Task Review aborted work unit nodeId");
    this.attempt = CurrentAttemptIdentity.from(value.attempt);
    this.manifest = new ReviewWorkUnitManifest(value.manifest);
    this.manifestDigest = digest(value.manifestDigest, "Task Review aborted work unit manifestDigest");
    this.seal = new ReviewWorkUnitSeal(value.seal);
    if (!Array.isArray(value.inputs) || value.inputs.length !== this.manifest.inputs.length) {
      throw new Error("Task Review aborted work unit inputs are invalid");
    }
    this.inputs = Object.freeze(value.inputs.map((saved, index) => {
      exact(saved, ["relativePath", "bytes"], "Task Review aborted work unit input");
      const input = this.manifest.inputs[index];
      const bytes = Buffer.from(base64(saved.bytes, "Task Review aborted work unit input bytes"), "base64");
      if (saved.relativePath !== input.relativePath || bytes.length !== input.byteLength
        || crypto.createHash("sha256").update(bytes).digest("hex") !== input.digest) {
        throw new Error("Task Review aborted work unit input receipt is invalid");
      }
      return Object.freeze({ relativePath: saved.relativePath, bytes: saved.bytes });
    }));
    exact(value.output, ["mediaType", "digest", "byteLength", "bytes"], "Task Review aborted work unit output");
    this.output = Object.freeze({
      mediaType: text(value.output.mediaType, "Task Review aborted work unit output mediaType"),
      digest: digest(value.output.digest, "Task Review aborted work unit output digest"),
      byteLength: value.output.byteLength,
      bytes: base64(value.output.bytes, "Task Review aborted work unit output bytes"),
    });
    const bytes = Buffer.from(this.output.bytes, "base64");
    if (!Number.isSafeInteger(this.output.byteLength) || this.output.byteLength < 0
      || bytes.length !== this.output.byteLength || crypto.createHash("sha256").update(bytes).digest("hex") !== this.output.digest) {
      throw new Error("Task Review aborted work unit output receipt is invalid");
    }
    if (this.nodeId !== `${this.taskId}-review` || this.attempt.nodeId !== this.nodeId
      || this.manifest.runId !== this.runId || this.manifest.specId !== this.specId
      || this.manifest.taskId !== this.taskId || this.manifest.nodeId !== this.nodeId
      || this.manifest.attemptId !== this.attempt.id || this.manifest.phase !== "impl"
      || this.manifest.digest !== this.manifestDigest) {
      throw new Error("Task Review aborted work unit identity is inconsistent");
    }
    this.seal.assertManifest(this.manifest);
    if (this.seal.output.digest !== this.output.digest || this.seal.output.byteLength !== this.output.byteLength
      || this.manifest.output.mediaType !== this.output.mediaType) {
      throw new Error("Task Review aborted work unit seal does not bind its output");
    }
    this.digest = hash(this.unsignedJSON());
    if (this.digest !== digest(value.digest, "Task Review aborted work unit digest")) {
      throw new Error("Task Review aborted work unit digest is invalid");
    }
    Object.freeze(this);
  }

  static capture(worker) {
    if (!(worker instanceof ReviewWorkUnit)) throw new Error("Task Review aborted work unit requires a sealed worker");
    const sealed = worker.readSealedOutput();
    const manifest = worker.manifestDocument;
    if (manifest.phase !== "impl" || manifest.taskId === null || manifest.nodeId !== `${manifest.taskId}-review`) {
      throw new Error("Task Review aborted work unit requires a Task Review worker");
    }
    const unsigned = {
      version: 1,
      runId: manifest.runId,
      specId: manifest.specId,
      taskId: manifest.taskId,
      nodeId: manifest.nodeId,
      attempt: { id: manifest.attemptId, nodeId: manifest.nodeId, sequence: null },
      manifest: manifest.toJSON(),
      manifestDigest: manifest.digest,
      seal: sealed.seal.toJSON(),
      inputs: manifest.inputs.map((input) => ({
        relativePath: input.relativePath,
        bytes: input.assertSnapshot(worker.root).bytes.toString("base64"),
      })),
      output: {
        mediaType: manifest.output.mediaType,
        digest: sealed.seal.output.digest,
        byteLength: sealed.seal.output.byteLength,
        bytes: sealed.bytes.toString("base64"),
      },
    };
    return unsigned;
  }

  static forAttempt(worker, attempt) {
    const value = TaskReviewAbortedWorkUnit.capture(worker);
    const identity = CurrentAttemptIdentity.from(attempt);
    value.attempt = identity.toJSON();
    return new TaskReviewAbortedWorkUnit({ ...value, digest: hash(value) });
  }

  unsignedJSON() {
    return { version: this.version, runId: this.runId, specId: this.specId, taskId: this.taskId, nodeId: this.nodeId,
      attempt: this.attempt.toJSON(), manifest: this.manifest.toJSON(), manifestDigest: this.manifestDigest,
      seal: this.seal.toJSON(), inputs: this.inputs.map((input) => ({ ...input })), output: { ...this.output } };
  }
  toJSON() { return { ...this.unsignedJSON(), digest: this.digest }; }
  assertActiveState(state) {
    if (state?.runId !== this.runId || state?.specId !== this.specId || !this.attempt.matches(state)
      || state.current?.at(-1) !== this.nodeId) throw new Error("Task Review aborted work unit does not match the active Attempt");
    return this;
  }
  get artifactWrite() {
    return new CanonicalFlowArtifactWrite({ logicalKey: TASK_REVIEW_ABORTED_WORK_UNIT_KEY,
      parameters: { taskId: this.taskId, attemptId: this.attempt.id }, mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(this.toJSON(), null, 2)}\n`) });
  }
}

/** Catalog-lock admission for retry publication of failed Review evidence. */
export class TaskReviewAbortedWorkUnitRetryAdmission {
  constructor({ state, archives = [] } = {}) {
    if (!state?.attempt || !Array.isArray(state.current)) {
      throw new Error("Task Review retry archive admission requires an active Attempt");
    }
    if (!Array.isArray(archives) || archives.some((archive) => !(archive instanceof TaskReviewAbortedWorkUnit))) {
      throw new Error("Task Review retry archive admission requires typed archives");
    }
    this.runId = state.runId;
    this.specId = state.specId;
    this.nodeId = state.current.at(-1);
    this.attempt = CurrentAttemptIdentity.from(state.attempt);
    this.archives = Object.freeze([...archives]);
    Object.freeze(this);
  }

  assert({ state, catalog, activities }) {
    if (state.runId !== this.runId || state.specId !== this.specId
      || state.current?.at(-1) !== this.nodeId || !this.attempt.matchesFailed(state)
      || !Array.isArray(activities) || !catalog?.artifacts) {
      throw new Error("Task Review retry archive admission changed before publication");
    }
    const identities = new Set();
    for (const archive of this.archives) {
      const identity = `${archive.taskId}:${archive.attempt.id}`;
      if (identities.has(identity) || archive.runId !== this.runId || archive.specId !== this.specId
        || archive.nodeId !== this.nodeId || archive.attempt.sequence > this.attempt.sequence) {
        throw new Error("Task Review retry archive identity does not match the active successor");
      }
      identities.add(identity);
      const failures = activities.filter((activity) => (
        activity.transition?.operation === "fail_attempt"
        && activity.nodeId === archive.nodeId
        && activity.attemptId === archive.attempt.id
        && activity.sequence === archive.attempt.sequence
      ));
      if (failures.length !== 1 || failures[0].failure?.category !== "tooling"
        || activities.some((activity) => (
          activity.type === "result_confirmed"
          && activity.nodeId === archive.nodeId
          && activity.attemptId === archive.attempt.id
          && activity.sequence === archive.attempt.sequence
        ))
        || catalog.artifacts.some((descriptor) => (
          descriptor.logicalKey === TASK_REVIEW_ABORTED_WORK_UNIT_KEY
          && descriptor.relativePath === archive.artifactWrite.artifact.relativePath
        ))) {
        throw new Error("Task Review retry archive requires one unpublished tooling failure");
      }
    }
    return this;
  }
}

/**
 * Capture only sealed, unpublished tooling-failure surfaces for the current
 * Task Review episode.  Retry recovery calls this before its one Store
 * transaction; the archive itself contains every byte later used to verify
 * local cleanup.  An unknown or source-integrity failure is deliberately a
 * closed boundary, because an archive must never authorize source effects.
 */
export function captureTaskReviewAbortedWorkUnits({ executionRoot, state, activities, flowManager, catalog = null } = {}) {
  const taskId = state?.current?.at(-2) ?? null;
  const nodeId = state?.current?.at(-1) ?? null;
  if (typeof taskId !== "string" || nodeId !== `${taskId}-review` || !Array.isArray(activities)) return [];
  const namespace = reviewWorkUnitNamespace({ executionRoot, specId: state.specId, runId: state.runId });
  if (!fs.existsSync(namespace)) return [];
  const namespaceStat = fs.lstatSync(namespace);
  if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink() || fs.realpathSync(namespace) !== path.resolve(namespace)) {
    throw new Error("Task Review aborted work unit namespace is not a real directory");
  }
  const archives = [];
  for (const entry of fs.readdirSync(namespace, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Task Review aborted work unit namespace has an invalid entry");
    }
    const directory = path.join(namespace, entry.name);
    const manifestPath = path.join(directory, "manifest.json");
    const sealPath = path.join(directory, "seal.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(sealPath)) continue;
    const worker = ReviewWorkUnit.fromEnvironment(
      { [REVIEW_WORK_UNIT_MANIFEST_ENV]: manifestPath },
      { expectedDirectory: directory },
    );
    const manifest = worker.manifestDocument;
    if (manifest.runId !== state.runId || manifest.specId !== state.specId) {
      throw new Error("Task Review aborted work unit namespace contains a foreign identity");
    }
    if (manifest.phase !== "impl" || manifest.taskId !== taskId || manifest.nodeId !== nodeId) continue;
    if (activities.some((activity) => (
      activity.type === "result_confirmed"
      && activity.nodeId === manifest.nodeId
      && activity.attemptId === manifest.attemptId
    ))) continue;
    if (flowManager !== undefined && flowManager !== null) {
      const archived = readTaskReviewAbortedWorkUnit({
        flowManager,
        state,
        worker,
        catalog,
        activities,
      });
      if (archived !== null) continue;
    }
    const failure = exactToolingFailure(activities, manifest);
    archives.push(TaskReviewAbortedWorkUnit.forAttempt(worker, {
      id: failure.attemptId,
      nodeId: failure.nodeId,
      sequence: failure.sequence,
    }));
  }
  return Object.freeze(archives);
}

/** Read an archive only when the catalog and the failed Activity agree. */
export function readTaskReviewAbortedWorkUnit({ flowManager, state, worker, catalog = null, activities = null } = {}) {
  if (!(worker instanceof ReviewWorkUnit)) throw new Error("Task Review aborted work unit reader requires a worker");
  const manifest = worker.manifestDocument;
  const resolvedCatalog = catalog ?? flowManager.artifactCatalog(state.specId);
  const resolvedActivities = activities ?? flowManager.activityLedger(state.specId);
  const relativePath = FLOW_ARTIFACT_CONTRACTS.resolve(
    TASK_REVIEW_ABORTED_WORK_UNIT_KEY,
    { taskId: manifest.taskId, attemptId: manifest.attemptId },
  ).relativePath;
  const descriptor = resolvedCatalog.artifacts
    .find((entry) => entry.logicalKey === TASK_REVIEW_ABORTED_WORK_UNIT_KEY && entry.relativePath === relativePath) ?? null;
  if (descriptor === null) return null;
  const artifactPath = flowManager.specLocation(state.specId).resolve(descriptor.relativePath);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Task Review aborted work unit archive is not a regular artifact");
  }
  const bytes = fs.readFileSync(artifactPath);
  if (bytes.length !== descriptor.size || crypto.createHash("sha256").update(bytes).digest("hex") !== descriptor.hash) {
    throw new Error("Task Review aborted work unit archive does not match its catalog descriptor");
  }
  const archive = new TaskReviewAbortedWorkUnit(JSON.parse(bytes.toString("utf8")));
  const publication = descriptor?.activityId === null ? null
    : resolvedActivities.find((entry) => entry.id === descriptor.activityId);
  const failures = resolvedActivities.filter((entry) => (
    entry.transition?.operation === "fail_attempt"
    && entry.nodeId === archive.nodeId
    && entry.attemptId === archive.attempt.id
    && entry.sequence === archive.attempt.sequence
  ));
  const failure = failures.length === 1 ? failures[0] : null;
  const publicationMatchesFailure = publication?.id === failure?.id;
  const publicationMatchesSuccessor = ["retry_attempt", "retry_recovery_attempt"].includes(publication?.transition?.operation)
    && publication.nodeId === archive.nodeId
    && publication.transition.attempt?.nodeId === archive.nodeId
    && publication.transition.attempt.sequence > archive.attempt.sequence;
  if (descriptor?.logicalKey !== TASK_REVIEW_ABORTED_WORK_UNIT_KEY
    || archive.runId !== state.runId || archive.specId !== state.specId
    || archive.attempt.id !== manifest.attemptId || archive.nodeId !== manifest.nodeId
    || archive.manifestDigest !== manifest.digest
    || failure?.failure?.category !== "tooling"
    || (!publicationMatchesFailure && !publicationMatchesSuccessor)) {
    throw new Error("Task Review aborted work unit has no matching tooling failure publication");
  }
  if (resolvedActivities.some((candidate) => (
    candidate.type === "result_confirmed"
    && candidate.nodeId === archive.nodeId
    && candidate.attemptId === archive.attempt.id
    && candidate.sequence === archive.attempt.sequence
  ))) {
    throw new Error("Task Review aborted work unit cannot replace a published producer result");
  }
  const sealed = worker.readSealedOutput();
  if (archive.output.digest !== sealed.seal.output.digest
    || archive.output.byteLength !== sealed.seal.output.byteLength
    || !Buffer.from(archive.output.bytes, "base64").equals(sealed.bytes)) {
    throw new Error("Task Review aborted work unit bytes differ from its archive");
  }
  return archive;
}
