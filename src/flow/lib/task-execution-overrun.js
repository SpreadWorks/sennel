/** Lock-scoped facts and admission for a stale Task implementation Attempt. */

import {
  TASK_EXECUTION_ROUND_POLICY,
  TaskExecutionOverrunFacts,
  TaskExecutionOverrunPublication,
} from "./task-execution-policy.js";
import {
  CurrentTaskSourceSnapshot,
  TaskMutationLineageSet,
  readTaskMutationLineagesFromCatalog,
} from "./task-mutation-lineage.js";
import { FlowActivity } from "./current-flow-state.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { PlanGateRepairRecord } from "./plan-gate-repair.js";
import { computeGitState } from "../../lib/git-state.js";

function publication(descriptor) {
  if (descriptor === null || descriptor.activityId === null) return null;
  return new TaskExecutionOverrunPublication({
    logicalKey: descriptor.logicalKey,
    relativePath: descriptor.relativePath,
    hash: descriptor.hash,
    activityId: descriptor.activityId,
  });
}

function descriptor(view, logicalKey, predicate = () => true) {
  return view.catalog.artifacts.find((entry) => entry.logicalKey === logicalKey && predicate(entry)) ?? null;
}

function receiptMatches({ entry, taskId, gateNodeId, gateResult, gatePublication }) {
  return entry?.trigger === "gate post hook (auto)"
    && entry.taskId === taskId
    && entry.step === gateNodeId
    && entry.gateReceipt?.attempt?.id === gateResult?.artifacts?.gateTransitionAttemptId
    && entry.gateReceipt?.attempt?.sequence === gateResult?.artifacts?.gateTransitionAttemptSequence
    && entry.gateReceipt?.catalogFingerprint === gatePublication.hash;
}

/** A completed gate:post may flush only its Task implementation agent metric after the stale repair. */
function isPostRepairTaskMetricObservation(entry, taskId) {
  return entry?.transition?.operation === "record_metric"
    && entry.type === "metric_recorded"
    && entry.nodeId === taskId
    && entry.attemptId === null
    && entry.sequence === null
    && entry.metric?.phase === `${taskId}-impl`
    && entry.metric?.kind === "agent";
}

/** Build facts only from one catalog-lock transition view. */
export function readTaskExecutionOverrunFactsFromView({ view, root }) {
  const state = view.state;
  if (state.lifecycle.state !== "active" || state.current === null || state.attempt === null) return null;
  const active = TaskStepIdentity.fromTaskNode(
    state.findNode(state.current.at(-2)), state.current.at(-1),
  );
  if (active === null || active.role !== "impl" || state.attempt.nodeId !== active.nodeId) return null;
  const task = state.findNode(active.taskId);
  const expected = ["impl", "review", "triage", "repair", "gate"].map((role) => `${active.taskId}-${role}`);
  if (!Array.isArray(task?.steps) || task.steps.length !== expected.length
    || task.steps.some((step, index) => step.id !== expected[index])
    || task.steps[0].status !== "in_progress"
    || task.steps.slice(1).some((step) => step.status !== "invalidated")) return null;
  const leaves = state.definition.orderedLeaves(state.root);
  const gateIndex = leaves.findIndex((leaf) => leaf.id === expected[4]);
  // The stale runtime left untouched successors either pending (never run)
  // or invalidated (cleared by an earlier repair).  Completed or active
  // successor state would make recovery cross real downstream work.
  if (gateIndex < 0 || leaves.slice(gateIndex + 1).some((leaf) => (
    !["pending", "invalidated"].includes(leaf.status) || leaf.result !== null
  ))) return null;

  const lineages = readTaskMutationLineagesFromCatalog({
    state, catalog: view.catalog, activities: view.activities, taskId: active.taskId,
    readCatalogedArtifact: view.readCatalogedArtifact,
  });
  const lineageSet = new TaskMutationLineageSet({
    runId: state.runId, specId: state.specId, taskId: active.taskId, lineages,
  });
  const implementations = lineageSet.lineages.filter((lineage) => lineage.role === "implementation");
  if (implementations.length !== TASK_EXECUTION_ROUND_POLICY.maximumRounds
    || implementations.some((lineage) => lineage.attempt.id === state.attempt.id)) return null;

  const repairs = view.activities.filter((entry) => (
    entry.transition?.operation === "plan_gate_repair"
    && entry.nodeId === active.nodeId
    && entry.attemptId === state.attempt.id
    && entry.sequence === state.attempt.sequence
  ));
  if (repairs.length !== 1) return null;
  const repair = repairs[0];
  if (repair?.transition?.operation !== "plan_gate_repair"
    || repair.nodeId !== active.nodeId || repair.attemptId !== state.attempt.id
    || repair.sequence !== state.attempt.sequence) return null;
  if (view.activities.some((entry) => (
    entry.confirmationOrder > repair.confirmationOrder
    && !isPostRepairTaskMetricObservation(entry, active.taskId)
  ))) return null;
  const issueDescriptor = descriptor(view, "issue.log");
  const gateDescriptor = descriptor(view, "task.gate", (entry) => entry.relativePath === `steps/impl/${active.taskId}/gate/result.json`);
  const issueLogPublication = publication(issueDescriptor);
  const gatePublication = publication(gateDescriptor);
  if (issueLogPublication === null || gatePublication === null) return null;
  let issueLog;
  try { issueLog = JSON.parse(view.readCatalogedArtifact(issueDescriptor).toString("utf8")); }
  catch { return null; }
  let record;
  try {
    record = PlanGateRepairRecord.resolveCanonical({
      state, targetStepId: active.nodeId, activities: view.activities, issueLog,
    });
  } catch { return null; }
  if (record === null || repair.references?.repairs?.length !== 1
    || repair.references.repairs[0].id !== record.idempotencyKey
    || repair.references.repairs[0].label !== record.sourceIssueLogId) return null;
  const sourceIssue = issueLog.entries.find((entry) => entry?.issueLogId === record.sourceIssueLogId) ?? null;
  if (!record.matchesIssueLogEntry(sourceIssue)) return null;
  let gateHistory;
  try {
    gateHistory = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "task.gate", bytes: view.readCatalogedArtifact(gateDescriptor),
    });
  } catch { return null; }
  const gateResult = gateHistory.current.payload;
  const gateNodeId = `${active.taskId}-gate`;
  const gateAttemptId = gateResult?.artifacts?.gateTransitionAttemptId;
  const gateAttemptSequence = gateResult?.artifacts?.gateTransitionAttemptSequence;
  const gatePublicationActivity = view.activities.find((entry) => entry.id === gatePublication.activityId) ?? null;
  if (gatePublicationActivity?.transition?.operation !== "publish_artifacts"
    || gatePublicationActivity.nodeId !== gateNodeId
    || gatePublicationActivity.attemptId !== gateAttemptId
    || gatePublicationActivity.sequence !== gateAttemptSequence) return null;
  const gateFailureCategory = gateResult?.artifacts?.gateTransitionFailureCategory ?? null;
  const gateFailures = view.activities.filter((entry) => (
    entry.transition?.operation === "fail_attempt"
    && entry.nodeId === gateNodeId
    && entry.attemptId === gateAttemptId
    && entry.sequence === gateAttemptSequence
    && entry.confirmationOrder > gatePublicationActivity.confirmationOrder
    && entry.confirmationOrder < repair.confirmationOrder
    && entry.failure?.category === gateFailureCategory?.category
    && entry.failure?.code === gateFailureCategory?.code
  ));
  if (gateFailures.length !== 1) return null;
  const gateFailure = gateFailures[0];
  const gateStarts = view.activities.filter((entry) => (
    FlowActivity.canonical(entry).startsAttempt({ nodeId: gateNodeId, id: gateAttemptId, sequence: gateAttemptSequence })
    && entry.confirmationOrder < gatePublicationActivity.confirmationOrder
  ));
  if (gateStarts.length !== 1) return null;
  const gateStart = gateStarts[0];
  if (gateResult?.result !== "fail" || gateResult?.artifacts?.gateTransitionFailureCategory?.category !== "semantic"
    || gateFailure === null || gateFailure.nodeId !== gateNodeId
    || gateFailure.failure.code !== gateResult.artifacts.gateTransitionFailureCategory.code
    || gateHistory.current.attempt !== gateFailure.sequence || gateStart === null
    || !receiptMatches({ entry: sourceIssue, taskId: active.taskId, gateNodeId, gateResult, gatePublication })) return null;
  const source = CurrentTaskSourceSnapshot.capture({ root, lineageSet });
  let worktree;
  try { worktree = computeGitState(root); } catch { return null; }
  if (source.fingerprint !== gateResult.artifacts.sourceFingerprint
    || sourceIssue.headSha !== worktree.headSha || sourceIssue.worktreeHash !== worktree.worktreeHash) return null;
  return new TaskExecutionOverrunFacts({
    runId: state.runId, specId: state.specId, taskId: active.taskId,
    attempt: state.attempt, completedRounds: implementations.length,
    snapshotRevision: view.revision,
    gate: {
      sourceStep: gateNodeId, sourceArtifact: gatePublication.relativePath, attempts: gateHistory.current.attempt,
      attempt: { id: gateFailure.attemptId, sequence: gateFailure.sequence },
      failure: { activityId: gateFailure.id, category: gateFailure.failure.category, code: gateFailure.failure.code },
      startActivityId: gateStart.id,
      publication: gatePublication,
    },
    issueLog: issueLogPublication,
    repair: {
      activityId: repair.id, attempt: { id: repair.attemptId, sequence: repair.sequence },
      recordId: record.idempotencyKey, sourceIssueLogId: record.sourceIssueLogId,
      sourceEntryDigest: record.sourceEntryDigest,
    },
    sourceFingerprint: source.fingerprint, worktree,
  });
}

/** Revalidate every stable fact under the publication lock immediately before apply. */
export class TaskExecutionOverrunAdmission {
  constructor({ facts, root } = {}) {
    if (!(facts instanceof TaskExecutionOverrunFacts)) throw new Error("Task execution overrun admission requires Definition facts");
    if (typeof root !== "string" || root === "") throw new Error("Task execution overrun admission requires execution root");
    this.facts = facts;
    this.root = root;
    Object.freeze(this);
  }

  assert(view) {
    const current = readTaskExecutionOverrunFactsFromView({ view, root: this.root });
    if (current === null || !this.facts.matches(current)) {
      throw new Error("Task execution overrun admission is stale or evidence changed before recovery");
    }
  }
}

/** Read all state, ledger, catalog and source evidence through one lock-scoped view. */
export function readTaskExecutionOverrunFacts({ flowManager, specId } = {}) {
  if (!flowManager || typeof flowManager.readCanonicalTransitionView !== "function"
    || typeof flowManager.executionRoot !== "function") {
    throw new Error("Task execution overrun facts require canonical FlowManager transition views");
  }
  const root = flowManager.executionRoot();
  return flowManager.readCanonicalTransitionView({
    specId,
    read: (view) => readTaskExecutionOverrunFactsFromView({ view, root }),
  });
}
