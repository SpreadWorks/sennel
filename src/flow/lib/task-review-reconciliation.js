import path from "node:path";
import crypto from "node:crypto";
import { resolveTaskReviewReconciliation } from "../definition.js";
import { CurrentAttemptIdentity } from "./current-flow-state.js";
import { TaskReviewUnsealedWorkUnitSet } from "./review-work-unit.js";
import { captureCurrentTaskSource } from "./task-mutation-lineage.js";
import { SourceMutationBaseline, WorkerArtifactRepositoryMutationSnapshot } from "./worker-artifact-handoff.js";
import { ReviewExecutionLease } from "./review-execution-lease.js";
import { captureRetryRecoveryBaseline, readRetryBaseline, retryEvidenceRouteForNode } from "./retry-recovery.js";
import { TaskReviewReconciliationProposal, TaskReviewReconciliationRecord, TASK_REVIEW_RECONCILIATION_KEY, reconciliationDigest } from "./task-review-reconciliation-record.js";

function currentBaseline({ flowManager, state, root, attempt = state.attempt }) {
  const location = flowManager.specLocation(state.specId);
  const baseline = captureRetryRecoveryBaseline({
    flowState: flowManager.loadReadOnly(state.specId), flowManager, executionRoot: root,
    artifactRoot: location.repositoryRoot, specPath: location.relativeSpecFile,
    nodeId: state.attempt.nodeId, attempt,
  });
  if (baseline === null) throw new Error("Task Review reconciliation cannot observe current input");
  return baseline;
}

function currentSnapshot(root, attempt, location) {
  return new SourceMutationBaseline({ attempt, snapshot: WorkerArtifactRepositoryMutationSnapshot.capture({ root, authorities: ["execution"],
    ignoredDirectories: [".tmp", ".sennel/agent-cache", ".sennel/review-execution-locks", ".sennel/review-work-units"],
    runtimeLocks: [location.runtimeLock("runtime.lock.artifact-catalog"), location.runtimeLock("runtime.lock.current-flow-state")],
  }) });
}

function archive(worker) {
  const manifest = worker.manifestDocument;
  return {
    manifest: manifest.toJSON(), manifestDigest: manifest.digest,
    inputs: manifest.inputs.map(input => ({ relativePath: input.relativePath, bytes: input.assertSnapshot(worker.root).bytes.toString("base64") })),
  };
}

/** Read-only proposal; all mutable inputs are bound to an explicit digest. */
export function prepareTaskReviewReconciliation({ flowManager, specId, root }) {
  const state = flowManager.canonicalState(specId);
  const catalog = flowManager.artifactCatalog(specId);
  const activities = flowManager.activityLedger(specId);
  const decision = resolveTaskReviewReconciliation({ state, catalog, activities });
  const taskId = decision.taskId;
  const retained = TaskReviewUnsealedWorkUnitSet.recover({
    executionRoot: root, runId: state.runId, specId, taskId, nodeId: state.attempt.nodeId,
    acceptedAttemptIds: new Set(activities.filter(a => a.nodeId === state.attempt.nodeId && a.attemptId).map(a => a.attemptId)),
  });
  const baseline = currentBaseline({ flowManager, state, root });
  const snapshot = currentSnapshot(root, state.attempt, flowManager.specLocation(specId));
  const proposal = {
    runId: state.runId, specId, issue: state.issue ?? null, taskId, nodeId: state.attempt.nodeId,
    previousAttempt: CurrentAttemptIdentity.from(state.attempt).toJSON(),
    stateDigest: reconciliationDigest(state.toJSON()), catalogDigest: reconciliationDigest(catalog.toJSON()),
    sourceFingerprint: captureCurrentTaskSource({ root, flowManager, state, taskId }).fingerprint,
    snapshot: snapshot.toJSON(), baseline: baseline.toJSON(),
    workUnits: retained.workUnits.map(archive),
  };
  return TaskReviewReconciliationProposal.create(proposal);
}

/** Re-check the proposal inside the catalog transaction, before any publication. */
export class TaskReviewReconciliationAdmission {
  constructor({ flowManager, root, proposal }) {
    if (!(proposal instanceof TaskReviewReconciliationProposal)) throw new Error("Task Review reconciliation admission requires a typed proposal");
    this.root = root; this.proposal = proposal;
    Object.freeze(this);
  }
  assert(view) {
    resolveTaskReviewReconciliation(view);
    if (reconciliationDigest(view.state.toJSON()) !== this.proposal.stateDigest
      || reconciliationDigest(view.catalog.toJSON()) !== this.proposal.catalogDigest) {
      throw new Error("Task Review reconciliation proposal is stale");
    }
    // Do not re-enter the catalog lock through FlowManager. Canonical inputs
    // are bound by view above; inspect only the checkout and retained files here.
    const snapshot = currentSnapshot(this.root, view.state.attempt, view.location);
    const retained = TaskReviewUnsealedWorkUnitSet.recover({ executionRoot: this.root, runId: view.state.runId,
      specId: view.state.specId, taskId: this.proposal.taskId, nodeId: view.state.attempt.nodeId,
      acceptedAttemptIds: new Set(view.activities.filter(a => a.nodeId === view.state.attempt.nodeId && a.attemptId).map(a => a.attemptId)),
    });
    if (snapshot.digest !== this.proposal.snapshot.digest
      || reconciliationDigest(retained.workUnits.map(archive)) !== reconciliationDigest(this.proposal.workUnits)) {
      throw new Error("Task Review reconciliation input changed before publication");
    }
  }
}

/** Catalog and Activity readback, including archived input hashes. */
export function readTaskReviewReconciliations({ flowManager, state, taskId }) {
  const catalog = flowManager.artifactCatalog(state.specId);
  const activities = flowManager.activityLedger(state.specId);
  const records = [];
  for (const descriptor of catalog.artifacts.filter(a => a.logicalKey === TASK_REVIEW_RECONCILIATION_KEY
    && a.relativePath.startsWith(`steps/impl/${taskId}/review/recovery/reconciliations/`))) {
    const attemptId = path.basename(descriptor.relativePath, ".json");
    const source = flowManager.readArtifact({ specId: state.specId, logicalKey: TASK_REVIEW_RECONCILIATION_KEY,
      parameters: { taskId, attemptId }, consumerNodeId: `${taskId}-review` });
    if (crypto.createHash("sha256").update(source.bytes).digest("hex") !== descriptor.hash) throw new Error("Task Review reconciliation catalog hash mismatch");
    const record = new TaskReviewReconciliationRecord(JSON.parse(source.bytes));
    const activity = activities.find(a => a.id === descriptor.activityId);
    if (record.proposal.runId !== state.runId || record.proposal.specId !== state.specId
      || record.proposal.taskId !== taskId || record.currentAttempt.id !== attemptId
      || activity?.transition.operation !== "retry_recovery_attempt"
      || activity.attemptId !== attemptId || activity.sequence !== record.currentAttempt.sequence
      || activity.nodeId !== record.currentAttempt.nodeId || activity.transition.attempt?.id !== attemptId) {
      throw new Error("Task Review reconciliation has no matching publication Activity");
    }
    records.push(record);
  }
  return records;
}

/** Only this exact archived work unit is retired; its files are never deleted. */
export function isReconciledTaskReviewWorkUnit(worker, records) {
  const saved = records.flatMap(record => record.proposal.workUnits).filter(entry => entry.manifest.attemptId === worker.manifestDocument.attemptId);
  if (saved.length === 0) return false;
  const observed = archive(worker);
  if (!saved.some(entry => reconciliationDigest(entry) === reconciliationDigest(observed))) throw new Error("archived Task Review work unit changed after reconciliation");
  return true;
}

/** A reconciliation authorizes only the adopted input, not later checkout edits. */
export function assertReconciledTaskReviewInput({ flowManager, state, taskId, root }) {
  const record = readTaskReviewReconciliations({ flowManager, state, taskId }).find(r => r.currentAttempt.matches(state));
  if (!record) return;
  const saved = readRetryBaseline(flowManager, state, retryEvidenceRouteForNode(state, state.attempt.nodeId));
  const fresh = currentBaseline({ flowManager, state, root });
  const snapshot = currentSnapshot(root, state.attempt, flowManager.specLocation(state.specId)).snapshot;
  if (!saved || ["projectDigest", "runtimeDigest", "targetDigest"].some(k => saved[k] !== fresh[k])
    || ["mode", "head", "indexDigest"].some(k => snapshot[k] !== record.proposal.snapshot.snapshot[k])
    || captureCurrentTaskSource({ root, flowManager, state, taskId }).fingerprint !== record.proposal.sourceFingerprint) {
    throw new Error("reconciled Task Review input changed; a new explicit review decision is required");
  }
  const retained = TaskReviewUnsealedWorkUnitSet.recover({ executionRoot: root, runId: state.runId, specId: state.specId,
    taskId, nodeId: state.attempt.nodeId,
    acceptedAttemptIds: new Set(flowManager.activityLedger(state.specId).filter(a => a.nodeId === state.attempt.nodeId && a.attemptId).map(a => a.attemptId)),
  });
  for (const worker of retained.workUnits) {
    if (worker.manifestDocument.attemptId !== state.attempt.id && !isReconciledTaskReviewWorkUnit(worker, [record])) {
      throw new Error("Task Review has an unarchived prior work unit after reconciliation");
    }
  }
}

export function applyTaskReviewReconciliation({ flowManager, specId, root, expectDigest, reason, yes }) {
  if (yes !== true || typeof expectDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectDigest)) {
    throw new Error("Task Review reconciliation requires --yes and the exact --expect-digest from preview");
  }
  const state = flowManager.canonicalState(specId);
  const lease = new ReviewExecutionLease({ mainRoot: flowManager.specLocation(specId).repositoryRoot,
    runId: state.runId, nodeId: state.attempt.nodeId, attemptId: state.attempt.id });
  lease.acquire();
  try {
    const proposal = prepareTaskReviewReconciliation({ flowManager, specId, root });
    if (proposal.digest !== expectDigest) throw new Error("Task Review reconciliation preview is stale");
    const currentAttempt = { id: crypto.randomUUID(), nodeId: state.attempt.nodeId, sequence: state.attempt.sequence + 1 };
    const record = TaskReviewReconciliationRecord.create({ proposal, currentAttempt, reason });
    const baseline = currentBaseline({ flowManager, state, root, attempt: currentAttempt });
    return flowManager.reconcileTaskReview({ specId, record, baseline,
      admission: new TaskReviewReconciliationAdmission({ flowManager, root, proposal }) });
  } finally { lease.release(); }
}
