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
import { FlowSpecRevision } from "../../lib/flow-version.js";
import { CurrentFlowStateInvariantError } from "./current-flow-state.js";
import { validateAcceptanceReviewArtifact } from "./acceptance-review-artifacts.js";
import { TaskStepIdentity } from "./task-step-identity.js";

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
const ATTEMPT_HISTORY_ARTIFACTS = new Map([
  ["draft-questions-review", "draft.questions.review"],
  ["draft-coverage-review", "draft.coverage.review"],
  ["draft-gate", "draft.gate"],
  ["spec-gate", "spec.gate"],
  ["scenario-validity", "scenario.validity"],
  ["test-review", "test.review"],
  ["test-execute", "test.execute"],
  ["test-result-review", "test.result.review"],
  ["impl-review", "impl.review"],
  ["impl-gate", "impl.gate"],
  ["acceptance-review", "acceptance.review"],
  ["acceptance-decision", "acceptance.decision"],
  ["final-regression", "final.regression"],
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
  const logicalKey = ATTEMPT_HISTORY_ARTIFACTS.get(normalized);
  if (logicalKey !== undefined) return Object.freeze({ logicalKey, parameters: Object.freeze({}) });
  if (FLOW_TRIAGE_REPAIR_NODES.has(normalized)) return null;
  if (flowArtifactAuthorityForStep(normalized) !== null) return null;
  const task = normalized.match(/^(.+)-(review|triage|repair|gate)$/);
  if (task === null) return null;
  return Object.freeze({
    logicalKey: `task.${task[2]}`,
    parameters: Object.freeze({ taskId: task[1] }),
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
  const match = nodeId.match(/^(.+)-(impl|review|triage|repair|gate)$/);
  return match?.[2] === role ? match[1] : null;
}

function taskTargetRole(nodeId) {
  const match = nodeId.match(/^task-(impl|review|triage|repair|gate)$/);
  return match?.[1] ?? null;
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
  const consumerRole = taskTargetRole(target.consumer);
  return consumerRole !== null && taskNode(consumerNodeId, consumerRole) === producerTask;
}

function consumerNodeForTarget(target, producerNodeId) {
  const consumerRole = taskTargetRole(target.consumer);
  if (consumerRole === null) return target.consumer;
  const role = target.producer === "task-review" ? "review" : "gate";
  const taskId = taskNode(producerNodeId, role);
  return taskId === null ? null : `${taskId}-${consumerRole}`;
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

/** The coverage completion connector consumes its review evidence directly. */
function isConnectorConsumerHandoff(producerNodeId, consumerNodeId) {
  return producerNodeId === "draft-coverage-review"
    && consumerNodeId === "draft-coverage-repair";
}

function producerHandoffs(producerNodeId, consumerNodeId) {
  if (producerNodeId === "spec-review" && consumerNodeId === "spec-triage") {
    return [new RevisionScopedSpecReviewReadinessTarget({ producerNodeId, consumerNodeId })];
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

function acceptanceDecisionNoOpActivity({ producer, consumerNodeId, expectedAttemptId, activities }) {
  if (producer.id !== "acceptance-decision" || consumerNodeId !== "final-regression") return null;
  return activities.find((activity) => (
      activity.nodeId === producer.id
      && activity.attemptId === expectedAttemptId
      && activity.sequence === producer.attemptSequence
      && (
        activity.transition.operation === "complete_acceptance_decision_noop"
        || (activity.transition.operation === "confirm_attempt" && activity.result?.outcome === "passed")
      )
    )) ?? null;
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
    // A passed acceptance review owns the definition's explicit no-op path.
    // It creates a short, durable Attempt whose operation is distinct from an
    // operator decision. A cataloged acceptance.decision always takes
    // precedence, even though its normal confirmation is also `passed`.
    // Otherwise an explicit risk decision would be mistaken for a legacy
    // no-op and rejected for correctly having a non-PASS review verdict.
    if (producer.id === "acceptance-decision" && this.consumerNodeId === "final-regression") {
      expectedAttemptId = producerAttemptId(state, activities, producer);
      const hasCatalogedDecision = this.handoffs.some((handoff) => catalog.artifacts.some((entry) => (
        entry.relativePath === handoff.relativePath && entry.logicalKey === handoff.logicalKey
      )));
      if (!hasCatalogedDecision) {
        const noOp = acceptanceDecisionNoOpActivity({
          producer,
          consumerNodeId: this.consumerNodeId,
          expectedAttemptId,
          activities,
        });
        if (noOp !== null) {
          try {
            passedAcceptanceReview({ state, catalog, activities, readCatalogedArtifact });
            return;
          } catch (cause) {
            throw this.#missing(`acceptance decision no-op is not backed by cataloged PASS acceptance.review: ${cause.message}`);
          }
        }
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
      const deferredIntegrationSettlement = producer.id === "impl-gate"
        && producer.status === "done"
        && (activities.find((activity) => (
          activity.nodeId === producer.id
          && activity.transition.operation === "defer_failed_gate"
          && activity.sequence === producer.attemptSequence - 1
          && typeof activity.attemptId === "string"
          && activity.transition.attempt?.nodeId === producer.id
          && typeof activity.transition.attempt?.id === "string"
          && activity.transition.attempt?.id !== activity.attemptId
          && activity.transition.attempt?.sequence === producer.attemptSequence
          && activity.result?.outcome === "passed"
        )) ?? null);
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
            ))
          // Integration exhaustion introduces a settlement Attempt that
          // records flow.findings. Its immutable failed Gate artifact stays
          // on the immediately preceding producer Attempt, and only that
          // exact deferred settlement may advance retro.
          || (
            deferredIntegrationSettlement !== null
            && activity.transition.operation === "fail_attempt"
            && activity.result?.outcome === "failed"
            && activity.sequence === deferredIntegrationSettlement.sequence
            && activity.attemptId === deferredIntegrationSettlement.attemptId
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

/**
 * The only artifactless primary-result exception. A no-op decision is owned
 * by a cataloged PASS acceptance review, not by the command dispatcher.
 */
export class AcceptanceDecisionNoOpAdmission {
  constructor() {
    this.acceptanceReadiness = new ProducerArtifactReadiness({
      producerNodeId: "acceptance-review",
      consumerNodeId: "final-regression",
    });
    Object.freeze(this);
  }

  assert({ state, catalog, activities, readCatalogedArtifact }) {
    if (state?.current?.at(-1) !== "acceptance-decision" || state.attempt === null) {
      throw this.#denied("acceptance-decision is not the active Attempt");
    }
    try {
      passedAcceptanceReview({ state, catalog, activities, readCatalogedArtifact });
    } catch (cause) {
      throw this.#denied(cause.message);
    }
  }

  #denied(detail) {
    const error = new CurrentFlowStateInvariantError(`acceptance decision no-op is not authorized: ${detail}`);
    error.code = "CANONICAL_ACCEPTANCE_DECISION_NOOP_NOT_AUTHORIZED";
    return error;
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
    this.sourceConsumerAdmission.assert(snapshot);
    if (this.sourceProducerCompletionAdmission !== null) {
      this.sourceProducerCompletionAdmission.assert(snapshot);
    }
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
