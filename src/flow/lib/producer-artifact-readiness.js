/**
 * Catalog-backed admission rules for a consumer that depends on a canonical
 * producer result.  A result file is not evidence by itself: the descriptor
 * and the Activity that confirmed its producer must agree while the catalog
 * publication lock is held.
 */

import {
  FLOW_ARTIFACT_CONTRACTS,
  FLOW_ARTIFACT_SWITCH_TARGETS,
} from "../../lib/flow-artifact-contract.js";
import { flowArtifactAuthorityForStep } from "./flow-artifact-authority.js";
import { FlowSpecRevision } from "../../lib/flow-spec-revision.js";
import { CurrentFlowStateInvariantError } from "./current-flow-state.js";
import { validateAcceptanceReviewArtifact } from "./acceptance-review-artifacts.js";
import { TaskStepIdentity } from "./task-step-identity.js";
import { StepResult, stepResultDigest } from "../engine/step-result.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { isDeepStrictEqual } from "node:util";
import { AcceptedGateDeferral } from "./accepted-gate-deferral.js";
import { assertGateSettlementPublication } from "./gate-settlement-publication.js";
import { DraftStepSettlementReceipt, settleImplStepResult, settleTaskStepResult } from "../definition.js";

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CurrentFlowStateInvariantError(`${field} must be a non-empty string`);
  }
  return value;
}

// These are the durable result artifacts whose content contract retains every
// producer Attempt. They are the primary evidence contract; switch targets
// only link that evidence to its consumers and do not make optional outputs
// (such as nonblocking.handoffs) required.
class AttemptHistoryRoute {
  constructor(logicalKey, { directConsumers = [] } = {}) {
    this.logicalKey = requiredText(logicalKey, "attempt history logicalKey");
    this.directConsumers = Object.freeze(new Set(directConsumers));
    Object.freeze(this);
  }

  directlyConnects(consumerNodeId) {
    return this.directConsumers.has(consumerNodeId);
  }

  get directOnly() {
    return this.directConsumers.size > 0;
  }
}

const ATTEMPT_HISTORY_ARTIFACTS = new Map([
  ["draft-questions-review", new AttemptHistoryRoute("draft.questions.review")],
  ["draft-coverage-review", new AttemptHistoryRoute("draft.coverage.review")],
  ["draft-gate", new AttemptHistoryRoute("draft.gate")],
  ["spec-gate", new AttemptHistoryRoute("spec.gate")],
  ["test-review", new AttemptHistoryRoute("test.requirement.review", { directConsumers: ["test-repair", "test-gate"] })],
  ["test-gate", new AttemptHistoryRoute("test.requirement.gate", { directConsumers: ["test-generate", "implement"] })],
  ["test-execute", new AttemptHistoryRoute("test.execute")],
  ["test-result-review", new AttemptHistoryRoute("test.result.review")],
  ["impl-review", new AttemptHistoryRoute("impl.review")],
  ["impl-gate", new AttemptHistoryRoute("impl.gate")],
  ["acceptance-review", new AttemptHistoryRoute("acceptance.review")],
  ["acceptance-decision", new AttemptHistoryRoute("acceptance.decision")],
  ["final-regression", new AttemptHistoryRoute("final.regression")],
]);
const FLOW_TRIAGE_REPAIR_NODES = new Set([
  "draft-questions-triage", "draft-questions-repair",
  "draft-coverage-triage", "draft-coverage-repair",
  "spec-triage", "spec-repair", "impl-triage", "impl-repair",
]);
const TASK_REVIEW_STAGE_ROLES = new Set(["review", "triage", "repair"]);

export function attemptHistoryTargetForNode(nodeId) {
  const normalized = requiredText(nodeId, "canonical attempt history nodeId");
  // The spec review has a typed revision-scoped source below; it must not be
  // parsed by the generic task suffix grammar.
  if (normalized === "spec-review") return null;
  const route = ATTEMPT_HISTORY_ARTIFACTS.get(normalized);
  if (route !== undefined) return Object.freeze({ logicalKey: route.logicalKey, parameters: Object.freeze({}) });
  if (FLOW_TRIAGE_REPAIR_NODES.has(normalized)) return null;
  if (flowArtifactAuthorityForStep(normalized) !== null) return null;
  const task = TaskStepIdentity.fromNodeId(normalized);
  if (task === null || task.role === "impl") return null;
  return Object.freeze({
    logicalKey: `task.${task.role}`,
    parameters: Object.freeze({ taskId: task.taskId }),
  });
}

/** The review producer publishes the current revision's one review ledger,
 * rather than an attempt-history file.  This target resolves that collection
 * through its catalog descriptor and binds it to the exact review Attempt. */
class RevisionScopedSpecReviewReadinessTarget {
  constructor({ producerNodeId, consumerNodeId } = {}) {
    if (producerNodeId !== "spec-review" || consumerNodeId !== "spec-triage") {
      throw new CurrentFlowStateInvariantError("revision-scoped review readiness has an invalid route");
    }
    this.logicalKey = "spec.review";
    this.parameters = Object.freeze({});
    Object.freeze(this);
  }

  descriptor(catalog) {
    const matches = catalog.artifacts
      .filter((entry) => entry.logicalKey === this.logicalKey)
      .map((entry) => ({ entry, match: entry.relativePath.match(/^revisions\/(\d+)\/review\.json$/) }))
      .filter(({ match }) => match !== null)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
    return matches[0]?.entry ?? null;
  }

  publicationMatches(artifact) {
    const target = artifact?.artifact ?? artifact;
    if (target?.logicalKey !== this.logicalKey) return false;
    // Admission runs before the Store resolves a command publication to its
    // catalog path.  At that boundary the typed revision parameter is the
    // only authoritative address; after resolution the exact path remains
    // accepted for already-materialized writes.
    if (/^revisions\/\d+\/review\.json$/.test(target.relativePath ?? "")) return true;
    const revision = target.parameters?.revision;
    if (typeof revision !== "string" || !/^\d+$/.test(revision)) return false;
    try {
      return revision === new FlowSpecRevision(Number(revision)).pathSegment;
    } catch {
      return false;
    }
  }
}

function taskNode(nodeId, role) {
  const identity = TaskStepIdentity.fromNodeId(nodeId);
  return identity?.role === role ? identity.taskId : null;
}

function targetProducerMatches(target, producerNodeId) {
  if (target.producer === producerNodeId) return true;
  return target.producer === "task-review"
    ? taskNode(producerNodeId, "review") !== null
    : target.producer === "task-gate" && taskNode(producerNodeId, "gate") !== null;
}

function targetConsumerMatches(target, producerNodeId, consumerNodeId) {
  if (target.consumer === consumerNodeId) return true;
  const producerTask = taskNode(producerNodeId, target.producer === "task-review" ? "review" : "gate");
  if (producerTask === null) return false;
  const consumer = TaskStepIdentity.fromNodeId(consumerNodeId);
  return consumer !== null && consumer.definitionId === target.consumer && consumer.taskId === producerTask;
}

function consumerNodeForTarget(target, producerNodeId) {
  const consumer = TaskStepIdentity.fromNodeId(target.consumer);
  if (consumer?.taskId !== "task") return target.consumer;
  const role = target.producer === "task-review" ? "review" : "gate";
  const taskId = taskNode(producerNodeId, role);
  return taskId === null ? null : TaskStepIdentity.fromDefinitionId({ taskId, definitionId: target.consumer })?.nodeId ?? null;
}

function taskReviewStageRoute({ state, producerNodeId, consumerNodeId, logicalKey }) {
  const producer = TaskStepIdentity.fromStateNode(state, producerNodeId);
  const consumer = TaskStepIdentity.fromStateNode(state, consumerNodeId);
  if (producer === null || consumer === null || producer.taskId !== consumer.taskId) return null;
  if (!TASK_REVIEW_STAGE_ROLES.has(producer.role)) return null;
  if (logicalKey !== `task.${producer.role}`) return null;
  return Object.freeze({ producer, consumer });
}

function taskStageCompletionMatches({ route, expectedAttemptId, producer, descriptor, activity }) {
  if (route === null
    || activity.transition?.operation !== "advance_task_review_stage"
    || activity.id !== descriptor.activityId
    || activity.attemptId !== expectedAttemptId
    || activity.sequence !== producer.attemptSequence
    || activity.result?.outcome !== "passed") return false;
  const plan = activity.transition.taskReviewStagePlan;
  const binding = plan?.facts?.binding;
  return descriptor.logicalKey === `task.${route.producer.role}`
    && binding?.taskId === route.producer.taskId
    && binding?.stage === route.producer.role
    && binding.attemptId === expectedAttemptId
    && binding.attemptSequence === producer.attemptSequence
    && binding.artifactDigest === descriptor.hash;
}

/** The coverage completion connector consumes its review evidence at Gate. */
function isConnectorConsumerHandoff(producerNodeId, consumerNodeId) {
  return producerNodeId === "draft-coverage-review"
    && consumerNodeId === "draft-gate";
}

function producerHandoffs(producerNodeId, consumerNodeId) {
  if (producerNodeId === "spec-review" && consumerNodeId === "spec-triage") {
    return [new RevisionScopedSpecReviewReadinessTarget({ producerNodeId, consumerNodeId })];
  }
  const attemptHistoryRoute = ATTEMPT_HISTORY_ARTIFACTS.get(producerNodeId) ?? null;
  if (attemptHistoryRoute?.directOnly) {
    if (!attemptHistoryRoute.directlyConnects(consumerNodeId)) return [];
    const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(attemptHistoryRoute.logicalKey, {});
    return [Object.freeze({
      logicalKey: attemptHistoryRoute.logicalKey,
      parameters: Object.freeze({}),
      relativePath: artifact.relativePath,
      contract: artifact.contract,
    })];
  }
  const primary = attemptHistoryTargetForNode(producerNodeId);
  if (primary === null) return [];
  const switchTarget = FLOW_ARTIFACT_SWITCH_TARGETS.find((candidate) => (
    candidate.logicalKey === primary.logicalKey
    && targetProducerMatches(candidate, producerNodeId)
    && targetConsumerMatches(candidate, producerNodeId, consumerNodeId)
  )) ?? null;
  if (switchTarget === null && !isConnectorConsumerHandoff(producerNodeId, consumerNodeId)) {
    return [];
  }
  const artifact = FLOW_ARTIFACT_CONTRACTS.resolve(primary.logicalKey, primary.parameters);
  if (artifact.contract.cataloged !== true) {
    throw new CurrentFlowStateInvariantError("attempt history producer result must be cataloged");
  }
  return [Object.freeze({
    logicalKey: primary.logicalKey,
    parameters: primary.parameters,
    relativePath: artifact.relativePath,
    contract: artifact.contract,
  })];
}

function passedAcceptanceReview({ state, catalog, activities, readCatalogedArtifact }) {
  const readiness = new ProducerArtifactReadiness({
    producerNodeId: "acceptance-review",
    consumerNodeId: "final-regression",
  });
  readiness.assert({ state, catalog, activities, readCatalogedArtifact });
  const descriptor = catalog.artifacts.find((entry) => entry.logicalKey === "acceptance.review") ?? null;
  if (descriptor === null || typeof readCatalogedArtifact !== "function") {
    throw new CurrentFlowStateInvariantError("cataloged acceptance.review evidence is unavailable");
  }
  let artifact;
  try {
    const history = FLOW_ARTIFACT_CONTRACTS.require("acceptance.review").contentContract
      .parse(readCatalogedArtifact(descriptor));
    const acceptanceReview = state.findNode("acceptance-review");
    if (history.current?.attempt.value !== acceptanceReview?.attemptSequence) {
      throw new Error("acceptance.review history does not retain the confirmed producer Attempt");
    }
    artifact = validateAcceptanceReviewArtifact(history.current.payload.artifact?.payload);
  } catch (cause) {
    throw new CurrentFlowStateInvariantError(`acceptance.review evidence is invalid: ${cause.message}`);
  }
  if (artifact.verdict !== "pass") {
    throw new CurrentFlowStateInvariantError("acceptance.review does not authorize a no-op decision");
  }
}

function producerAttemptId(state, activities, producer) {
  if (state.current?.at(-1) === producer.id && state.attempt?.nodeId === producer.id) {
    return state.attempt.id;
  }
  const introduction = [...activities].reverse().find((activity) => (
    activity.transition?.attempt?.nodeId === producer.id
    && activity.transition.attempt.sequence === producer.attemptSequence
  )) ?? null;
  if (introduction === null || typeof introduction.transition.attempt.id !== "string") {
    throw new CurrentFlowStateInvariantError("producer artifact readiness requires the producer Attempt introduction");
  }
  return introduction.transition.attempt.id;
}

function nonblockingSourceMatches(producerNodeId, sourceStep) {
  return sourceStep === producerNodeId
    || (sourceStep === "task-review" && taskNode(producerNodeId, "review") !== null)
    || (sourceStep === "task-gate" && taskNode(producerNodeId, "gate") !== null);
}

function acceptedPriorAttemptSettlement({ state, producer, descriptor, activities, readCatalogedArtifact }) {
  if (producer.status !== "done") return null;
  for (const activity of activities) {
    const receipt = activity.result?.draftSettlementReceipt;
    if (activity.nodeId !== producer.id || activity.sequence !== producer.attemptSequence
      || !["continue_nonblocking", "defer_failed_gate"].includes(activity.transition?.operation) || receipt == null
      || activity.result?.stepResult == null) continue;
    const stored = activity.result.stepResult;
    const result = StepResult.fromStored(receipt.binding.stepId, stored.toJSON?.() ?? stored);
    const gateDeferral = activity.transition.operation === "defer_failed_gate";
    const decision = gateDeferral ? result.evidence?.continuation : result.evidence?.acceptedDecision;
    if (gateDeferral && !(decision instanceof AcceptedGateDeferral)) continue;
    if (decision == null) continue;
    const source = activities.find((entry) => entry.result?.draftSettlementReceipt?.id === decision.sourceReceiptId);
    const sourceReceipt = source?.result?.draftSettlementReceipt;
    if (source == null || source.result?.stepResult == null
      || activity.result.outcome !== "passed" || receipt.settlementKind !== "target-connection"
      || receipt.binding.attemptId !== activity.attemptId || receipt.binding.attemptSequence !== activity.sequence
      || decision.settlementAttempt.id !== activity.attemptId || decision.settlementAttempt.sequence !== activity.sequence
      || source.id !== descriptor.activityId || source.nodeId !== producer.id
      || decision.sourcePublication.producerActivityId !== descriptor.activityId
      || decision.sourcePublication.artifactId !== descriptor.relativePath || decision.sourcePublication.fingerprint !== descriptor.hash
      || source.attemptId !== decision.sourcePublication.attempt.id || source.sequence !== decision.sourcePublication.attempt.sequence) continue;
    const originalStored = source.result.stepResult;
    const original = StepResult.fromStored(sourceReceipt.binding.stepId, originalStored.toJSON?.() ?? originalStored);
    if (gateDeferral) {
      const binding = { runId: state.runId, specId: state.specId, stepId: result.stepId,
        attempt: decision.settlementAttempt };
      const selected = result.stepId === "task-gate" ? settleTaskStepResult(result.stepId, result)
        : settleImplStepResult(result.stepId, result);
      DraftStepSettlementReceipt.assertStored(receipt, { binding, result, settlement: selected });
      const sourceBinding = { ...binding, attempt: decision.sourcePublication.attempt };
      const sourceIdentity = result.evidence.identity;
      const introduction = activity.transition.attempt;
      const latestSource = activities.findLast((entry) => entry.nodeId === producer.id
        && entry.attemptId === source.attemptId && entry.sequence === source.sequence
        && entry.result?.draftSettlementReceipt != null);
      if (sourceIdentity.runId !== binding.runId || sourceIdentity.specId !== binding.specId
        || sourceIdentity.stepId !== producer.id || producer.result?.draftSettlementReceipt?.id !== receipt.id
        || introduction?.nodeId !== producer.id || introduction.id !== activity.attemptId
        || introduction.sequence !== activity.sequence || latestSource !== source
        || source.transition.operation !== "fail_attempt" || source.result.outcome !== "failed"
        || typeof readCatalogedArtifact !== "function") continue;
      const bytes = readCatalogedArtifact(descriptor);
      const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: descriptor.logicalKey, bytes });
      assertGateSettlementPublication({ state, activity: source, descriptor, historyEntry: history.current,
        attempt: sourceBinding.attempt, publicationBytes: bytes });
    } else decision.assertRecord(activity.transition.nonblocking);
    decision.assertOriginalSource({ receipt: sourceReceipt, resultDigest: stepResultDigest(original),
      evidence: result.evidence, originalEvidence: original.evidence?.toJSON() ?? original.error?.data?.evidence });
    return source;
  }
  return activities.find((activity) => {
    const transition = activity.transition;
    if (activity.nodeId !== producer.id
      || activity.sequence !== producer.attemptSequence - 1
      || typeof activity.attemptId !== "string"
      || transition?.attempt?.nodeId !== producer.id
      || typeof transition.attempt.id !== "string"
      || transition.attempt.id === activity.attemptId
      || transition.attempt.sequence !== producer.attemptSequence
      || activity.result?.outcome !== "passed") return false;
    if (transition.operation === "defer_failed_gate" || transition.operation === "defer_failed_review") {
      return true;
    }
    const decision = transition.nonblocking;
    return transition.operation === "continue_nonblocking"
      && decision?.kind === "decision"
      && decision.action === "continue"
      && nonblockingSourceMatches(producer.id, decision.sourceStep)
      && decision.sourceAttempt === activity.sequence
      && decision.evidenceRef === descriptor.relativePath;
  }) ?? null;
}

/** Exact accepted FAIL publication: the old failure receipt owns the new producer Attempt. */
function isAcceptedFinalRegressionPublication({ activity, descriptor, producer, activities, readCatalogedArtifact }) {
  if (producer.id !== "final-regression" || producer.status !== "done"
    || activity.transition.operation !== "accept_final_regression_failure") return false;
  const stored = activity.result?.stepResult;
  if (stored?.kind !== "final-regression-failure-accepted") return false;
  const result = StepResult.fromStored(producer.id, stored.toJSON?.() ?? stored);
  const receipt = activity.result?.draftSettlementReceipt;
  const evidence = result?.evidence;
  const acceptedBinding = receipt?.binding;
  const acceptedAttempt = activity.transition.attempt;
  if (result?.kind !== "final-regression-failure-accepted" || receipt?.resultKind !== result.kind
    || receipt.targetStepId !== "report" || acceptedBinding?.stepId !== producer.id
    || acceptedAttempt?.id !== activity.attemptId || acceptedAttempt.sequence !== activity.sequence
    || acceptedBinding.attemptId !== activity.attemptId || acceptedBinding.attemptSequence !== activity.sequence
    || evidence?.identity?.attempt?.id !== activity.attemptId || evidence.identity.attempt.sequence !== activity.sequence
    || evidence.publication?.producerActivityId !== activity.id || evidence.publication.artifactId !== descriptor.relativePath
    || evidence.publication.fingerprint !== descriptor.hash || evidence.observation?.recordAndProceed.accepted !== true) return false;
  const source = activities.findLast((entry) => entry.nodeId === producer.id
    && entry.sequence === activity.sequence - 1
    && entry.confirmationOrder < activity.confirmationOrder && entry.result?.stepResult?.kind === "final-regression-failed");
  const original = source?.result?.draftSettlementReceipt;
  const sourceStored = source?.result?.stepResult;
  const sourceResult = sourceStored == null ? null : StepResult.fromStored(producer.id, sourceStored.toJSON?.() ?? sourceStored);
  if (source?.transition.operation !== "fail_attempt" || source.result.outcome !== "failed"
    || original?.binding.attemptId !== source.attemptId || original.binding.attemptSequence !== source.sequence
    || original.binding.runId !== acceptedBinding.runId || original.binding.specId !== acceptedBinding.specId
    || sourceResult.evidence.publication.producerActivityId !== source.id
    || typeof readCatalogedArtifact !== "function") return false;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "final.regression", bytes: readCatalogedArtifact(descriptor) });
  const originalFailure = history.attempts.find((entry) => entry.attempt === source.sequence)?.payload;
  return history.current.attempt === activity.sequence && originalFailure?.result === "fail"
    && isDeepStrictEqual(history.current.payload.recordAndProceed.executionBinding, originalFailure.executionBinding);

}

/** Whether an Activity is the durable publication boundary of a Draft execution generation. */
export function isDraftExecutionPublicationActivity(activity) {
  return activity?.transition?.operation === "record_draft_step_settlement"
    && activity?.result?.draftSettlementReceipt?.settlementKind === "execution"
    && activity.result.draftSettlementReceipt.executionLifecycle?.phase === "publication";
}

/** A typed producer/consumer requirement, derived only from artifact contracts. */
export class ProducerArtifactReadiness {
  constructor({ producerNodeId, consumerNodeId } = {}) {
    this.producerNodeId = requiredText(producerNodeId, "producer artifact readiness producerNodeId");
    this.consumerNodeId = requiredText(consumerNodeId, "producer artifact readiness consumerNodeId");
    this.handoffs = Object.freeze(producerHandoffs(this.producerNodeId, this.consumerNodeId));
    Object.freeze(this);
  }

  get required() { return this.handoffs.length > 0; }

  /**
   * This runs from CurrentFlowVersionStore's catalog precondition.  That
   * keeps descriptor, confirmed Activity, and state identity in the same
   * serialized boundary as the consumer claim/terminal settlement.
   */
  assert({ state, catalog, activities, readCatalogedArtifact = undefined }) {
    const producer = state?.findNode?.(this.producerNodeId) ?? null;
    if (!producer || !Number.isSafeInteger(producer.attemptSequence) || producer.attemptSequence < 0
      || !catalog || !Array.isArray(catalog.artifacts) || !Array.isArray(activities)) {
      throw new CurrentFlowStateInvariantError("producer artifact readiness requires producer state, catalog, and confirmed Activities");
    }
    let expectedAttemptId = null;
    // The saved review settlement owns the definition's unexecuted decision.
    if (producer.id === "acceptance-decision" && this.consumerNodeId === "final-regression") {
      const source = state.unexecutedCompletionSource(producer.id);
      if (source?.id === "acceptance-review") {
        passedAcceptanceReview({ state, catalog, activities, readCatalogedArtifact });
        return;
      }
    }
    for (const handoff of this.handoffs) {
      const descriptor = handoff instanceof RevisionScopedSpecReviewReadinessTarget
        ? handoff.descriptor(catalog)
        : catalog.artifacts.find((entry) => (
          entry.relativePath === handoff.relativePath && entry.logicalKey === handoff.logicalKey
        )) ?? null;
      if (descriptor === null) {
        throw this.#missing(`catalog lacks ${handoff.logicalKey}`);
      }
      expectedAttemptId ??= producerAttemptId(state, activities, producer);
      const taskStageRoute = taskReviewStageRoute({
        state,
        producerNodeId: this.producerNodeId,
        consumerNodeId: this.consumerNodeId,
        logicalKey: handoff.logicalKey,
      });
      const acceptedPriorAttempt = acceptedPriorAttemptSettlement({ state, producer, descriptor, activities, readCatalogedArtifact });
      const confirmation = activities.find((activity) => (
        activity.id === descriptor.activityId
        && activity.nodeId === this.producerNodeId
        && (activity.transition.operation === "advance_task_review_stage"
          ? taskStageCompletionMatches({
            route: taskStageRoute,
            expectedAttemptId,
            producer,
            descriptor,
            activity,
          })
          : (
          (activity.sequence === producer.attemptSequence
            && activity.attemptId === expectedAttemptId
            && (
              (activity.transition.operation === "confirm_attempt" && activity.result?.outcome === "passed")
          // A semantic command may publish its typed producer result while
          // retaining the Attempt for a definition-owned failure route. The
          // failed producer Activity is the descriptor's exact association.
              || (activity.transition.operation === "fail_attempt"
                && activity.result?.outcome === "failed"
                && producer.status === "in_progress")
          // An explicit publication can likewise retain the active Attempt
          // for a Definition-owned route.
              || activity.transition.operation === "publish_artifacts"
              || isDraftExecutionPublicationActivity(activity)
              || isAcceptedFinalRegressionPublication({ activity, descriptor, producer, activities, readCatalogedArtifact })
            ))
          // A deferral or an explicit nonblocking continuation can settle a
          // failed producer through a replacement Attempt. The source artifact
          // remains on the immediately preceding Attempt; only its exact
          // accepted settlement may admit the downstream consumer.
          || (
            acceptedPriorAttempt !== null
            && (
              activity.transition.operation === "publish_artifacts"
              || (activity.transition.operation === "fail_attempt"
                && activity.result?.outcome === "failed")
            )
            && activity.sequence === acceptedPriorAttempt.sequence
            && activity.attemptId === acceptedPriorAttempt.attemptId
          )
          ))
      )) ?? null;
      if (confirmation === null) {
        throw this.#missing(`${handoff.logicalKey} has no matching confirmed producer Activity`);
      }
    }
  }

  isReady(snapshot) {
    try {
      this.assert(snapshot);
      return true;
    } catch (error) {
      if (error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY") return false;
      throw error;
    }
  }

  /**
   * A producer must place the same required result in the confirmation
   * transaction. This prevents a manually-confirmed producer from leaving a
   * terminal artifactless cursor that no consumer can ever claim.
   */
  assertPublication(artifactWrites) {
    if (!Array.isArray(artifactWrites)) {
      throw new CurrentFlowStateInvariantError("producer artifact publication requires artifact writes");
    }
    for (const handoff of this.handoffs) {
      const published = artifactWrites.some((write) => {
        const artifact = write?.artifact ?? write;
        if (artifact?.logicalKey !== handoff.logicalKey) return false;
        if (handoff instanceof RevisionScopedSpecReviewReadinessTarget) return handoff.publicationMatches(artifact);
        const relativePath = artifact.relativePath
          ?? FLOW_ARTIFACT_CONTRACTS.resolve(
            artifact.logicalKey,
            artifact.parameters ?? {},
          ).relativePath;
        return relativePath === handoff.relativePath;
      });
      if (!published) {
        throw this.#missing(`${handoff.logicalKey} is absent from the producer confirmation`);
      }
    }
  }

  #missing(detail) {
    const error = new CurrentFlowStateInvariantError(
      `canonical producer artifact is not ready for ${this.consumerNodeId}: ${detail}`,
    );
    error.code = "CANONICAL_PRODUCER_ARTIFACT_NOT_READY";
    error.producerNodeId = this.producerNodeId;
    error.consumerNodeId = this.consumerNodeId;
    return error;
  }
}

/**
 * Catalog-lock admission shared by consumer claim and producer settlement.
 * A non-adjacent result edge remains checked at the consumer's actual claim.
 */
function requiredReadinesses(value, field) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((readiness) => !(readiness instanceof ProducerArtifactReadiness) || !readiness.required)) {
    throw new CurrentFlowStateInvariantError(`${field} requires typed readiness`);
  }
  return Object.freeze([...value]);
}

export class ProducerArtifactReadinessAdmission {
  constructor({ readinesses } = {}) {
    this.readinesses = requiredReadinesses(readinesses, "producer artifact readiness admission");
    Object.freeze(this);
  }

  assert(snapshot) {
    for (const readiness of this.readinesses) readiness.assert(snapshot);
  }
}

/** Store precondition that binds a primary producer result to completion. */
export class ProducerArtifactPublicationAdmission {
  constructor({ readinesses, artifactWrites } = {}) {
    this.readinesses = requiredReadinesses(readinesses, "producer artifact publication");
    if (!Array.isArray(artifactWrites)) {
      throw new CurrentFlowStateInvariantError("producer artifact publication requires artifact writes");
    }
    const producerNodeId = this.readinesses[0].producerNodeId;
    if (this.readinesses.some((readiness) => readiness.producerNodeId !== producerNodeId)) {
      throw new CurrentFlowStateInvariantError("producer artifact publication readiness must share one producer");
    }
    this.artifactWrites = Object.freeze([...artifactWrites]);
    Object.freeze(this);
  }

  assert({ state, catalog, activities }) {
    if (state?.current?.at(-1) !== this.readinesses[0].producerNodeId || state.attempt === null) {
      throw new CurrentFlowStateInvariantError("producer artifact publication Attempt changed");
    }
    // Some typed worker boundaries publish their exact result before their
    // final confirmation Activity. That is still the current producer
    // Attempt, and the same catalog/Activity proof is sufficient.
    for (const readiness of this.readinesses) {
      if (readiness.isReady({ state, catalog, activities })) continue;
      readiness.assertPublication(this.artifactWrites);
    }
  }
}

/**
 * One atomic Step-connector admission evaluates the source's ordinary
 * consumer readiness and its producer-completion publication rule against
 * the same catalog-lock snapshot.  A source with no attempt-history output
 * has an explicit null producer admission; it is not represented by a
 * permissive empty readiness list.
 */
export class StepConnectionAdmission {
  constructor({ sourceConsumerAdmission, sourceProducerCompletionAdmission = null } = {}) {
    if (!(sourceConsumerAdmission instanceof ProducerArtifactReadinessAdmission)) {
      throw new CurrentFlowStateInvariantError("Step connection admission requires typed source consumer readiness");
    }
    if (sourceProducerCompletionAdmission !== null
      && !(sourceProducerCompletionAdmission instanceof ProducerArtifactPublicationAdmission)) {
      throw new CurrentFlowStateInvariantError("Step connection admission producer completion must be typed or null");
    }
    this.sourceConsumerAdmission = sourceConsumerAdmission;
    this.sourceProducerCompletionAdmission = sourceProducerCompletionAdmission;
    Object.freeze(this);
  }

  assert(snapshot) {
    if (this.sourceProducerCompletionAdmission === null) {
      this.sourceConsumerAdmission.assert(snapshot);
      return;
    }
    const sourceProducerNodeId = this.sourceProducerCompletionAdmission.readinesses[0].producerNodeId;
    for (const readiness of this.sourceConsumerAdmission.readinesses) {
      if (readiness.producerNodeId !== sourceProducerNodeId || readiness.isReady(snapshot)) {
        readiness.assert(snapshot);
        continue;
      }
      readiness.assertPublication(this.sourceProducerCompletionAdmission.artifactWrites);
    }
    this.sourceProducerCompletionAdmission.assert(snapshot);
  }
}

/**
 * The inverse admission used only to repair persisted historical corruption.
 * It binds the exact run, consumer Attempt, producer Attempt, and still-missing
 * catalog output before the Store appends the one recovery Activity.
 */
export class MissingProducerArtifactRecoveryAdmission {
  constructor({ runId, consumerAttempt, producerAttempt, readiness } = {}) {
    this.runId = requiredText(runId, "missing producer artifact recovery runId");
    this.consumerAttempt = consumerAttempt;
    this.producerAttempt = producerAttempt;
    if (!(readiness instanceof ProducerArtifactReadiness) || !readiness.required) {
      throw new CurrentFlowStateInvariantError("missing producer artifact recovery requires a typed producer readiness");
    }
    this.readiness = readiness;
    Object.freeze(this);
  }

  assert({ state, catalog, activities }) {
    const consumerMatches = this.consumerAttempt === null
      ? state?.current === null && state?.attempt === null
      : state?.current?.at(-1) === this.consumerAttempt.nodeId
        && state.attempt?.id === this.consumerAttempt.id
        && state.attempt?.sequence === this.consumerAttempt.sequence
        && state.attempt?.nodeId === this.consumerAttempt.nodeId;
    if (state?.runId !== this.runId || !consumerMatches) {
      throw this.#mismatch("active consumer Attempt changed");
    }
    const producer = state.findNode(this.producerAttempt.nodeId);
    if (
      producer?.status !== "failed"
      || producer.attemptSequence !== this.producerAttempt.sequence
      || this.producerAttempt.failure === null
    ) {
      throw this.#mismatch("recorded producer Attempt changed");
    }
    const failed = activities.find((activity) => (
      activity.nodeId === this.producerAttempt.nodeId
      && activity.attemptId === this.producerAttempt.id
      && activity.sequence === this.producerAttempt.sequence
      && activity.transition?.operation === "fail_attempt"
    )) ?? null;
    const recorded = activities.find((activity) => (
      activity.nodeId === this.producerAttempt.nodeId
      && activity.attemptId === this.producerAttempt.id
      && activity.sequence === this.producerAttempt.sequence
      && activity.transition?.operation === "record_failure"
    )) ?? null;
    if (failed === null || recorded === null || failed.failure === null) {
      throw this.#mismatch("producer failure ledger identity changed");
    }
    if (this.readiness.isReady({ state, catalog, activities })) {
      throw this.#mismatch("producer artifact is now ready");
    }
  }

  #mismatch(detail) {
    const error = new CurrentFlowStateInvariantError(
      `missing producer artifact recovery target changed: ${detail}`,
    );
    error.code = "CANONICAL_MISSING_PRODUCER_ARTIFACT_RECOVERY_STALE";
    return error;
  }
}

/** A typed next-action routing fact for a missing producer result. */
export class MissingProducerArtifactRoute {
  constructor({ kind, producerNodeId, consumerNodeId = null, readiness } = {}) {
    if (!["active-producer", "historical-consumer", "historical-gap"].includes(kind)) {
      throw new CurrentFlowStateInvariantError("missing producer artifact route kind is invalid");
    }
    this.kind = kind;
    this.producerNodeId = requiredText(producerNodeId, "missing producer artifact route producerNodeId");
    this.consumerNodeId = consumerNodeId === null
      ? null
      : requiredText(consumerNodeId, "missing producer artifact route consumerNodeId");
    if (!(readiness instanceof ProducerArtifactReadiness) || !readiness.required) {
      throw new CurrentFlowStateInvariantError("missing producer artifact route requires typed readiness");
    }
    this.readiness = readiness;
    Object.freeze(this);
  }
}

export function producerArtifactReadiness({ producerNodeId, consumerNodeId } = {}) {
  const readiness = new ProducerArtifactReadiness({ producerNodeId, consumerNodeId });
  return readiness.required ? readiness : null;
}

export function producerArtifactReadinessesForProducer({ producerNodeId } = {}) {
  const producer = requiredText(producerNodeId, "producer artifact readiness producerNodeId");
  const consumers = new Set(
    FLOW_ARTIFACT_SWITCH_TARGETS
      .filter((target) => targetProducerMatches(target, producer))
      .map((target) => consumerNodeForTarget(target, producer))
      .filter(Boolean),
  );
  if (producer === "spec-review") consumers.add("spec-triage");
  return Object.freeze([...consumers]
    .map((consumerNodeId) => producerArtifactReadiness({ producerNodeId: producer, consumerNodeId }))
    .filter(Boolean));
}

export function producerArtifactReadinessesForConsumer({ producerNodeIds, consumerNodeId } = {}) {
  if (!Array.isArray(producerNodeIds)) {
    throw new CurrentFlowStateInvariantError("producer artifact readiness consumer producerNodeIds must be an array");
  }
  const consumer = requiredText(consumerNodeId, "producer artifact readiness consumerNodeId");
  return Object.freeze(producerNodeIds
    .map((producerNodeId) => producerArtifactReadiness({ producerNodeId, consumerNodeId: consumer }))
    .filter(Boolean));
}
