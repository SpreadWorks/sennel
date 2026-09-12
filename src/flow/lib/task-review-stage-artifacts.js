import crypto from "node:crypto";
import { TaskRepairRecurrence } from "./review-recurrence.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskReviewAccounting } from "./task-review-accounting.js";
import { CurrentTaskSourceSnapshot, TaskMutationLineageSet } from "./task-mutation-lineage.js";
import { SourceTriageEffect } from "./source-triage-contract.js";
import { ApprovedFindingExceptionSet } from "./acknowledged-rationale.js";
import { CanonicalTaskContext } from "./task-canonical-context.js";
import { TaskReviewExecutionIdentity } from "./task-review-execution-identity.js";
import {
  SourceMutationBaseline,
  SourceMutationManifest,
  SourceWorkerCanonicalObservationAdvance,
} from "./worker-artifact-handoff.js";
import { loadMergedGuardrails } from "../../lib/guardrail.js";

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }

function digest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function canonicalSpecFromView(view) {
  const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === "spec.record") ?? null;
  if (descriptor === null) throw new Error("Task Review publication requires its canonical spec record");
  const bytes = view.readCatalogedArtifact(descriptor);
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error(`Task Review publication has invalid canonical spec: ${cause.message}`); }
  return { bytes, document };
}

/**
 * Parent-owned Task Review identity retained from execution until the catalog
 * transaction.  It binds the exact child Attempt, source baseline, and the
 * metric-only canonical observation that may occur while that child runs.
 */
export class TaskReviewPublicationBinding {
  constructor({ executionIdentity, source, context, specDigest, baseline, manifest, canonicalObservation } = {}) {
    if (!(executionIdentity instanceof TaskReviewExecutionIdentity)) throw new Error("Task Review publication requires its execution identity");
    if (!(source instanceof CurrentTaskSourceSnapshot)) throw new Error("Task Review publication requires its source snapshot");
    if (!(context instanceof CanonicalTaskContext)) throw new Error("Task Review publication requires its canonical context");
    if (!(baseline instanceof SourceMutationBaseline) || !(manifest instanceof SourceMutationManifest)) {
      throw new Error("Task Review publication requires its source baseline and observation");
    }
    if (!(canonicalObservation instanceof SourceWorkerCanonicalObservationAdvance)) {
      throw new Error("Task Review publication requires its canonical observation");
    }
    this.executionIdentity = executionIdentity;
    this.source = source;
    this.context = context;
    this.specDigest = digest(specDigest, "Task Review publication specDigest");
    this.baseline = baseline;
    this.manifest = manifest;
    this.canonicalObservation = canonicalObservation;
    executionIdentity.assertTask(source.taskId);
    if (source.runId !== context.runId || source.specId !== context.specId || source.taskId !== context.taskId
      || source.fingerprint !== context.sourceFingerprint || baseline.attempt.id !== executionIdentity.attempt.id
      || baseline.attempt.sequence !== executionIdentity.attempt.sequence || baseline.attempt.nodeId !== executionIdentity.attempt.nodeId) {
      throw new Error("Task Review publication binding is internally inconsistent");
    }
    manifest.assertBinding(baseline);
    if (manifest.mutations.length !== 0) throw new Error("Task Review publication cannot bind source mutations");
    Object.freeze(this);
  }

  assert(view) {
    const attempt = view.state.attempt;
    if (view.state.current?.at(-1) !== this.executionIdentity.attempt.nodeId
      || attempt?.id !== this.executionIdentity.attempt.id
      || attempt?.nodeId !== this.executionIdentity.attempt.nodeId
      || attempt?.sequence !== this.executionIdentity.attempt.sequence
      || view.state.runId !== this.source.runId || view.state.specId !== this.source.specId) {
      throw new Error("Task Review publication Attempt or Task binding changed before canonical publication");
    }
    this.manifest.assertMatchesCurrent(this.baseline);
    this.canonicalObservation.assertTransitionView(view);
    const { bytes, document } = canonicalSpecFromView(view);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== this.specDigest) {
      throw new Error("Task Review canonical spec changed before publication");
    }
    const currentContext = new CanonicalTaskContext({
      state: { runId: view.state.runId, specId: view.state.specId, currentTaskId: this.source.taskId },
      spec: document,
      sourceFingerprint: this.source.fingerprint,
    });
    if (currentContext.fingerprint !== this.context.fingerprint) {
      throw new Error("Task Review canonical context changed before publication");
    }
  }
}

/** Check reviewed source again under the catalog lock without reentering the Store. */
export class TaskReviewSourcePublicationAdmission {
  constructor({ root, lineageSet, sourceFingerprint, producerAdmission, publicationBinding }) {
    if (!(lineageSet instanceof TaskMutationLineageSet)) throw new Error("Task review publication requires canonical lineage");
    if (!(publicationBinding instanceof TaskReviewPublicationBinding)) throw new Error("Task review publication requires its parent-owned execution binding");
    this.root = root;
    this.lineageSet = lineageSet;
    this.sourceFingerprint = sourceFingerprint;
    this.producerAdmission = producerAdmission;
    this.publicationBinding = publicationBinding;
    if (sourceFingerprint !== publicationBinding.source.fingerprint) throw new Error("Task review publication source binding is inconsistent");
    Object.freeze(this);
  }

  assert(view) {
    view.state.assertAttemptConfirmable();
    this.producerAdmission?.assert(view);
    if (CurrentTaskSourceSnapshot.capture({ root: this.root, lineageSet: this.lineageSet }).fingerprint !== this.sourceFingerprint) {
      throw new Error("Task review source changed before canonical publication");
    }
    this.publicationBinding.assert(view);
  }
}

/** Immutable publication identity, including the actual producing Attempt. */
export class TaskStageArtifactReference {
  constructor({ logicalKey, digest, activityId, attemptId, sequence, payloadDigest }) {
    this.logicalKey = text(logicalKey, "Task artifact key");
    for (const [field, value] of Object.entries({ digest, payloadDigest })) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Task artifact ${field} is invalid`);
      this[field] = value;
    }
    this.activityId = text(activityId, "Task artifact Activity");
    this.attemptId = text(attemptId, "Task artifact Attempt");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Task artifact Attempt sequence is invalid");
    this.sequence = sequence;
    Object.freeze(this);
  }
  toJSON() { return { logicalKey: this.logicalKey, digest: this.digest, payloadDigest: this.payloadDigest, activityId: this.activityId, attemptId: this.attemptId, sequence: this.sequence }; }
}

/** A Task stage reads only cataloged history backed by its producer Activity. */
export class TaskStageArtifact {
  constructor({ flowManager, state, taskId, role, optional = false }) {
    this.logicalKey = `task.${role}`;
    const relativePath = `steps/impl/${taskId}/${role}/result.json`;
    const descriptor = flowManager.artifactCatalog(state.specId).artifacts.find((entry) => entry.logicalKey === this.logicalKey && entry.relativePath === relativePath);
    if (!descriptor) {
      if (optional) { this.reference = null; this.history = null; this.document = null; Object.freeze(this); return; }
      throw new Error(`canonical Task ${role} publication is required`);
    }
    const bytes = flowManager.readArtifact({ specId: state.specId, logicalKey: this.logicalKey, parameters: { taskId }, consumerNodeId: "system" }).bytes;
    this.history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: this.logicalKey, bytes });
    const activity = flowManager.activityLedger(state.specId).find((entry) => entry.id === descriptor.activityId);
    if (activity?.nodeId !== `${taskId}-${role}` || activity.sequence !== this.history.current.attempt) throw new Error(`canonical Task ${role} producer does not match its history`);
    this.document = this.history.current.payload;
    this.reference = new TaskStageArtifactReference({ logicalKey: this.logicalKey, digest: descriptor.hash, payloadDigest: hash(this.document), activityId: descriptor.activityId, attemptId: activity.attemptId, sequence: activity.sequence });
    Object.freeze(this);
  }
}

/** Common immutable binding carried by triage and repair, never supplied by a worker. */
export class TaskReviewEpisodeBinding {
  constructor({ runId, specId, flowVersion, taskId, taskRound, reviewOrdinal, specDigest, contextDigest, sourceFingerprint, review, triage = null }) {
    for (const [field, value] of Object.entries({ runId, specId, taskId })) this[field] = text(value, `Task stage ${field}`);
    if (flowVersion !== 1) throw new Error("Task stage requires Flow Version 1");
    this.flowVersion = flowVersion;
    if (![1, 2].includes(taskRound) || ![1, 2, 3, 4].includes(reviewOrdinal)) throw new Error("Task stage semantic budget is invalid");
    this.taskRound = taskRound;
    this.reviewOrdinal = reviewOrdinal;
    for (const [field, value] of Object.entries({ specDigest, contextDigest, sourceFingerprint })) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Task stage ${field} is invalid`);
      this[field] = value;
    }
    this.review = review instanceof TaskStageArtifactReference ? review : new TaskStageArtifactReference(review);
    this.triage = triage === null ? null : triage instanceof TaskStageArtifactReference ? triage : new TaskStageArtifactReference(triage);
    Object.freeze(this);
  }
  toJSON() { return { runId: this.runId, specId: this.specId, flowVersion: this.flowVersion, taskId: this.taskId, taskRound: this.taskRound, reviewOrdinal: this.reviewOrdinal, specDigest: this.specDigest, contextDigest: this.contextDigest, sourceFingerprint: this.sourceFingerprint, review: this.review.toJSON(), triage: this.triage?.toJSON() ?? null }; }
  matches(other, { includeTriage = true } = {}) {
    const left = this.toJSON(); const right = other.toJSON();
    if (!includeTriage) { left.triage = null; right.triage = null; }
    return stable(left) === stable(right);
  }
}

/** Canonical Task review episode supplied to both worker stages and their parent. */
export class TaskReviewStageInputs {
  constructor({ flowManager, state, taskId, context, stage }) {
    if (!["task-triage", "task-repair"].includes(stage)) throw new Error("unsupported Task review stage");
    this.stage = stage;
    this.taskId = taskId;
    this.lineageSet = new TaskMutationLineageSet({ runId: state.runId, specId: state.specId, taskId, lineages: flowManager.taskMutationLineages({ specId: state.specId, taskId }) });
    this.review = new TaskStageArtifact({ flowManager, state, taskId, role: "review" });
    this.triage = stage === "task-repair" ? new TaskStageArtifact({ flowManager, state, taskId, role: "triage" }) : null;
    const accounting = new TaskReviewAccounting({ taskId, budget: this.lineageSet.currentBudget, history: this.review.history });
    const spec = flowManager.readArtifact({ specId: state.specId, logicalKey: "spec.record", consumerNodeId: "system" });
    const specDocument = JSON.parse(spec.bytes.toString("utf8"));
    this.approvedExceptions = ApprovedFindingExceptionSet.fromCanonical({
      spec: specDocument,
      guardrails: loadMergedGuardrails(flowManager.executionRoot()),
    });
    this.binding = new TaskReviewEpisodeBinding({ runId: state.runId, specId: state.specId, flowVersion: state.version, taskId, taskRound: this.lineageSet.currentBudget.round, reviewOrdinal: accounting.completedReviewCount, specDigest: crypto.createHash("sha256").update(spec.bytes).digest("hex"), contextDigest: context.fingerprint, sourceFingerprint: context.sourceFingerprint, review: this.review.reference, triage: this.triage?.reference ?? null });
    if (this.review.document.taskId !== taskId || this.review.document.canonicalTaskSource?.fingerprint !== context.sourceFingerprint || this.review.document.canonicalTaskSource?.specDigest !== this.binding.specDigest || this.review.document.canonicalTaskSource?.contextFingerprint !== context.fingerprint) throw new Error("Task review source binding is stale or belongs to another Task");
    if (this.triage !== null && !this.binding.matches(new TaskReviewEpisodeBinding(this.triage.document.binding), { includeTriage: false })) throw new Error("Task triage does not bind the current review episode");
    this.findings = Object.freeze([...(this.review.document.blockingFindings ?? []), ...(this.review.document.nonBlockingImprovements ?? [])]);
    if (this.findings.some((finding) => !finding.findingKey) || new Set(this.findings.map((finding) => finding.findingKey)).size !== this.findings.length) throw new Error("Task review finding identities are invalid");
    if (this.triage !== null) {
      this.assertTriage(this.triage.document);
      if (!this.triage.document.dispositions.some((entry) => entry.disposition === "apply") || this.lineageSet.paths.length === 0) throw new Error("Task repair requires applicable findings and authorized source paths");
    }
    this.recurrence = this.triage === null ? null : new TaskRepairRecurrence({
      flowManager, state, taskId, findings: this.findings, dispositions: this.triage.document.dispositions,
    });
    Object.freeze(this);
  }

  assertTriage(triage) {
    const effect = triage instanceof SourceTriageEffect
      ? triage
      : new SourceTriageEffect({ version: triage?.version, dispositions: triage?.dispositions });
    effect.assertCanonicalFindings(this.findings, { approvedExceptions: this.approvedExceptions });
  }

  assertRepair(repair, manifest) {
    const apply = this.triage.document.dispositions.filter((entry) => entry.disposition === "apply").map((entry) => entry.findingKey);
    if (apply.length !== repair.appliedFindingKeys.length || apply.some((key) => !repair.appliedFindingKeys.includes(key))) throw new Error("Task repair must apply exactly the canonical triage findings");
    repair.assertManifest(manifest);
    repair.assertRecurrenceResolutions(this.recurrence.toJSON());
    if (manifest.paths().length === 0 || manifest.paths().some((path) => !this.lineageSet.paths.includes(path))) throw new Error("Task repair mutations must remain within the authorized Task lineage");
  }

  workerDocuments() {
    return [
      { name: "task-review.json", document: this.review.document },
      ...(this.triage === null ? [] : [{ name: "task-triage.json", document: this.triage.document }, { name: "task-review-recurrence.json", document: this.recurrence.toJSON() }]),
      { name: "task-review-binding.json", document: this.binding.toJSON() },
      { name: "task-source-authority.json", document: { taskId: this.taskId, sourceFingerprint: this.binding.sourceFingerprint, allowedPaths: [...this.lineageSet.paths], lineageFingerprints: this.lineageSet.lineages.map((lineage) => lineage.fingerprint) } },
      { name: "task-approved-finding-exceptions.json", document: this.approvedExceptions.toJSON() },
    ];
  }
}

/** Durable stage evidence retains the findings even when every decision rejects them. */
export class TaskReviewStageResult {
  constructor({ inputs, effect, manifest, attempt, handoffDigest }) {
    if (!(inputs instanceof TaskReviewStageInputs)) throw new Error("Task stage result requires canonical inputs");
    this.version = 1;
    this.taskId = inputs.taskId;
    this.binding = inputs.binding;
    this.attempt = Object.freeze({ id: text(attempt.id, "Task stage result Attempt"), nodeId: attempt.nodeId, sequence: attempt.sequence });
    if (this.attempt.nodeId !== `${this.taskId}-${inputs.stage.slice(5)}`) throw new Error("Task stage result has a foreign producer");
    this.handoffDigest = text(handoffDigest, "Task stage handoff digest");
    this.reviewFindings = inputs.findings;
    this.effect = effect;
    this.manifest = manifest;
    this.unreviewedAfterRepair = inputs.stage === "task-repair" && inputs.binding.reviewOrdinal === 4;
    Object.freeze(this);
  }
  toJSON() {
    return {
      version: this.version, taskId: this.taskId, binding: this.binding.toJSON(), attempt: this.attempt,
      handoffDigest: this.handoffDigest, reviewFindings: this.reviewFindings,
      ...(this.effect.triage === null ? {} : this.effect.triage.toJSON()),
      ...(this.effect.repair === null ? {} : { repair: this.effect.repair.toJSON(), sourceMutationManifest: this.manifest.toJSON() }),
      unreviewedAfterRepair: this.unreviewedAfterRepair,
    };
  }
}
