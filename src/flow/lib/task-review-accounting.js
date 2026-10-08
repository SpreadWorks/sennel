/**
 * Canonical semantic accounting for one Task Review execution round.
 *
 * Attempt sequence is a transport/lifecycle clock: provider retries and
 * recovery can advance it without producing a Review result.  The semantic
 * Review budget instead consists only of durable `task.review` history
 * entries published after this round's implementation budget began.
 */
import {
  CurrentAttemptIdentity,
  CurrentFlowState,
  FlowActivity,
} from "./current-flow-state.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FLOW_ARTIFACT_CONTRACTS, FlowArtifactAttemptHistory } from "../../lib/flow-artifact-contract.js";
import { settleTaskStepResult, DraftStepSettlementReceipt } from "../definition.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { TaskExecutionBudget } from "./task-execution-policy.js";

const MAXIMUM_TASK_REVIEW_RESULTS = 4;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function taskReviewDescriptor({ flowManager, state, taskId }) {
  const expectedPath = FLOW_ARTIFACT_CONTRACTS.resolve("task.review", { taskId }).relativePath;
  const matches = flowManager.artifactCatalog(state.specId).artifacts.filter((entry) => (
    entry.logicalKey === "task.review" && entry.relativePath === expectedPath
  ));
  if (matches.length > 1) throw new Error("Task Review has duplicate canonical result publications");
  return matches[0] ?? null;
}

/** Read only semantic history completed by its actual registered Review save. */
export function canonicalTaskReviewHistory({ flowManager, state, taskId, history = null, descriptor = null, bytes = null }) {
  descriptor ??= taskReviewDescriptor({ flowManager, state, taskId });
  if (descriptor === null) return null;
  bytes ??= flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "task.review",
      parameters: { taskId },
      consumerNodeId: "system",
    }).bytes;
  history ??= CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "task.review", bytes });
  const envelopes = FLOW_ARTIFACT_CONTRACTS.require("task.review").contentContract.parse(bytes);
  const activities = flowManager.activityLedger(state.specId);
  const publication = activities.find((activity) => activity.id === descriptor.activityId) ?? null;
  const identity = new TaskStepIdentity({ taskId, role: "review" });
  const current = history.current;
  if (
    publication?.nodeId !== identity.nodeId
    || publication.attemptId === null
    || publication.attemptId === undefined
    || publication.attemptId === ""
    || publication.sequence !== current.attempt
  ) {
    throw new Error("Task Review canonical result history is not bound to its catalog publication");
  }
  const budgets = flowManager.taskMutationLineages({ specId: state.specId, taskId })
    .filter((lineage) => lineage.role === "implementation").map((lineage) => lineage.budget);
  const completed = [];
  let prefix = new FlowArtifactAttemptHistory();
  for (let index = 0; index < history.attempts.length; index += 1) {
    const entry = history.attempts[index];
    prefix = prefix.append(envelopes.attempts[index]);
    const terminal = activities.filter((activity) => activity.nodeId === identity.nodeId
      && activity.sequence === entry.attempt && activity.result?.draftSettlementReceipt?.settlementKind === "target-connection");
    if (terminal.length === 0) continue;
    if (terminal.length !== 1) throw new Error("Task Review semantic history has duplicate terminal producers");
    const activity = new FlowActivity(terminal[0]);
    const result = activity.result.stepResult;
    const facts = result.evidence?.facts;
    const settlement = settleTaskStepResult(identity.definitionId, result);
    const receipt = DraftStepSettlementReceipt.assertStored(activity.result.draftSettlementReceipt, {
      binding: { runId: state.runId, specId: state.specId, stepId: identity.definitionId,
        attempt: { id: activity.attemptId, sequence: activity.sequence } }, result, settlement });
    const budget = budgets.find((candidate) => candidate.round === facts?.taskRound);
    if (budget === undefined) throw new Error("Task Review semantic history has no matching implementation round budget");
    const next = budgets.find((candidate) => candidate.round === budget.round + 1);
    const ordinal = completed.filter((candidate) => candidate.attempt > budget.reviewAttemptSequenceAtStart).length + 1;
    const artifactDigest = createHash("sha256").update(`${JSON.stringify(prefix.toJSON(), null, 2)}\n`).digest("hex");
    const lifecycle = receipt.executionLifecycle?.toJSON();
    const claim = activities.findLast((candidate) => candidate.nodeId === identity.nodeId
      && candidate.attemptId === activity.attemptId && candidate.sequence === entry.attempt
      && candidate.confirmationOrder < activity.confirmationOrder
      && candidate.result?.draftSettlementReceipt?.executionLifecycle?.phase === "claimed"
      && isDeepStrictEqual(candidate.result.draftSettlementReceipt.executionLifecycle.binding, lifecycle?.binding));
    if (!["complete_task_review_stage", "advance_task_review_stage"].includes(activity.transition.operation)
      || result.stepId !== identity.definitionId || facts?.binding.stage !== "review" || facts.unavailable !== null
      || activity.result.outcome !== "passed" || facts.binding.runId !== state.runId || facts.binding.specId !== state.specId
      || facts.binding.taskId !== taskId || facts.binding.attemptId !== activity.attemptId
      || facts.binding.attemptSequence !== entry.attempt || facts.binding.sourceStepId !== identity.nodeId
      || facts.binding.artifactDigest !== artifactDigest || facts.verdict !== entry.payload.verdict
      || facts.findingCount !== (entry.payload.blockingFindings ?? []).length + (entry.payload.nonBlockingImprovements ?? []).length
      || facts.mustFixCount !== (entry.payload.blockingFindings ?? []).filter((finding) => finding.disposition === "must-fix").length
      || entry.payload.taskId !== taskId || entry.payload.canonicalTaskSource?.fingerprint !== facts.binding.sourceFingerprint
      || entry.attempt <= budget.reviewAttemptSequenceAtStart
      || next !== undefined && entry.attempt > next.reviewAttemptSequenceAtStart
      || facts.reviewResultCount !== ordinal
      || !isDeepStrictEqual(activity.transition.taskReviewStagePlan?.facts.toJSON(), facts.toJSON())
      || !isDeepStrictEqual(settlement.application?.transition.facts.toJSON(), facts.toJSON())
      || lifecycle?.phase !== "terminal" || lifecycle.binding.kind !== "review" || claim === undefined
      || !isDeepStrictEqual(lifecycle.claim, claim.result.draftSettlementReceipt.executionLifecycle.claim)
      || !isDeepStrictEqual(lifecycle.binding.target, entry.payload.canonicalTarget)) {
      throw new Error("Task Review semantic history lacks its exact completed Result, source, budget and execution receipt");
    }
    if (entry.attempt === current.attempt && descriptor.activityId !== activity.id) {
      throw new Error("Task Review latest semantic entry is not its canonical terminal producer");
    }
    completed.push(entry);
  }
  return completed.length === 0 ? null : new CanonicalCommandAttemptArtifactHistory({ logicalKey: "task.review",
    attempts: completed.map((entry) => ({ attempt: entry.attempt,
      artifact: { logicalKey: "task.review", payload: entry.payload } })) });
}

function currentBudget({ flowManager, state, taskId }) {
  const lineages = flowManager.taskMutationLineages({ specId: state.specId, taskId });
  const budget = lineages.at(-1)?.budget ?? null;
  if (!(budget instanceof TaskExecutionBudget)) {
    throw new Error("Task Review requires a canonical Task execution budget");
  }
  return budget;
}

/**
 * A read-only, typed view of completed semantic results and the one currently
 * executable ordinal.  It deliberately does not use Attempt consumption:
 * semantic retry accounting and Task Review's four-result contract differ.
 */
export class TaskReviewAccounting {
  constructor({ taskId, budget, history = null, activeAttempt = null, roundEndAttemptSequence = null } = {}) {
    this.taskId = text(taskId, "Task Review accounting taskId");
    this.budget = budget instanceof TaskExecutionBudget ? budget : new TaskExecutionBudget(budget);
    if (history !== null && !(history instanceof CanonicalCommandAttemptArtifactHistory)) {
      throw new Error("Task Review accounting history must be canonical");
    }
    this.history = history;
    this.activeAttempt = activeAttempt === null ? null : CurrentAttemptIdentity.from(activeAttempt);
    if (roundEndAttemptSequence !== null && (
      !Number.isSafeInteger(roundEndAttemptSequence)
      || roundEndAttemptSequence < this.budget.reviewAttemptSequenceAtStart
    )) {
      throw new Error("Task Review accounting round end is invalid");
    }
    this.roundEndAttemptSequence = roundEndAttemptSequence;
    if (this.activeAttempt !== null
      && !new TaskStepIdentity({ taskId: this.taskId, role: "review" }).matchesNode(this.activeAttempt.nodeId)) {
      throw new Error("Task Review accounting active Attempt does not match its Task");
    }
    const entries = (history?.attempts ?? []).filter((entry) => (
      entry.attempt > this.budget.reviewAttemptSequenceAtStart
      && (this.roundEndAttemptSequence === null || entry.attempt <= this.roundEndAttemptSequence)
    ));
    if (entries.length > MAXIMUM_TASK_REVIEW_RESULTS) {
      throw new Error("Task Review completed result count exceeds the current Task round budget");
    }
    this.completed = Object.freeze(entries.map((entry) => Object.freeze({
      attempt: entry.attempt,
      payload: entry.payload,
    })));
    this.completedReviewCount = this.completed.length;
    const publishedActive = this.activeAttempt !== null
      && this.completed.some((entry) => entry.attempt === this.activeAttempt.sequence);
    if (this.activeAttempt !== null && this.completed.some((entry) => entry.attempt > this.activeAttempt.sequence)) {
      throw new Error("Task Review accounting history is newer than its active Attempt");
    }
    this.inflightReviewOrdinal = this.activeAttempt === null || publishedActive
      ? null
      : this.completedReviewCount + 1;
    if (this.inflightReviewOrdinal !== null && this.inflightReviewOrdinal > MAXIMUM_TASK_REVIEW_RESULTS) {
      throw new Error("Task Review inflight ordinal exceeds the current Task round budget");
    }
    Object.freeze(this);
  }

  static fromCanonicalState({ flowManager, state, taskId } = {}) {
    if (!(state instanceof CurrentFlowState)) {
      throw new Error("Task Review accounting requires canonical Flow state");
    }
    const id = text(taskId, "Task Review accounting taskId");
    return new TaskReviewAccounting({
      taskId: id,
      budget: currentBudget({ flowManager, state, taskId: id }),
      history: canonicalTaskReviewHistory({ flowManager, state, taskId: id }),
      activeAttempt: state.attempt,
    });
  }

  completedOrdinalForSequence(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Task Review completed ordinal requires an Attempt sequence");
    }
    const index = this.completed.findIndex((entry) => entry.attempt === sequence);
    return index < 0 ? null : index + 1;
  }

  requireInflightReviewOrdinal() {
    if (this.inflightReviewOrdinal === null) {
      throw new Error("Task Review has no unpublished active semantic Review ordinal");
    }
    return this.inflightReviewOrdinal;
  }
}
