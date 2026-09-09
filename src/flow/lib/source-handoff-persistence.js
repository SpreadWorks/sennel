import crypto from "node:crypto";
import {
  FLOW_ARTIFACT_CONTRACTS,
} from "../../lib/flow-artifact-contract.js";
import {
  CanonicalSourceHandoffCheckpoint,
  SourceHandoffEvent,
  SourceHandoffSettlement,
  SourceMutationManifest,
  SourceWorkerHandoffIdentity,
  sourceHandoffCanonicalGeneration,
} from "./worker-artifact-handoff.js";
import { CurrentAttemptIdentity, CurrentFlowStateConflictError, CurrentFlowStateInvariantError } from "./current-flow-state.js";

const CHECKPOINT_KEY = "source.handoff.checkpoint";
const EVENT_KEY = "source.handoff.event";
const SETTLEMENT_KEY = "source.handoff.settlement";
const ROLLBACK_BLOB_KEY = "source.handoff.rollback-blob";

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJSON(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (cause) {
    throw new CurrentFlowStateInvariantError(`${label} is invalid JSON: ${cause.message}`);
  }
}

function eventParameters(event) {
  return {
    handoffId: event.identity.storageId,
    eventSequence: String(event.sequence).padStart(6, "0"),
    eventDigest: event.digest,
  };
}

function eventPrefix(identity) {
  const sample = FLOW_ARTIFACT_CONTRACTS.resolve(EVENT_KEY, {
    handoffId: identity.storageId,
    eventSequence: "000001",
    eventDigest: "0".repeat(64),
  }).relativePath;
  return sample.slice(0, sample.lastIndexOf("/") + 1);
}

function protocolDescriptors(view, identity) {
  const checkpointPath = FLOW_ARTIFACT_CONTRACTS.resolve(CHECKPOINT_KEY, { handoffId: identity.storageId }).relativePath;
  const prefix = checkpointPath.slice(0, checkpointPath.lastIndexOf("/") + 1);
  return view.catalog.artifacts.filter((entry) => (
    entry.relativePath.startsWith(prefix)
      && new Set([CHECKPOINT_KEY, EVENT_KEY, ROLLBACK_BLOB_KEY, SETTLEMENT_KEY]).has(entry.logicalKey)
  ));
}

function identityMatchesState(identity, state) {
  const attempt = CurrentAttemptIdentity.from(identity.attempt);
  return JSON.stringify(identity.flowIdentity.toJSON()) === JSON.stringify(state.identity.toJSON())
    && identity.runId === state.runId && identity.specId === state.specId
    && (attempt.matches(state) || attempt.matchesFailed(state));
}

function assertSameIdentity(expected, actual, label) {
  if (!(expected instanceof SourceWorkerHandoffIdentity) || !expected.matches(actual)) {
    throw new CurrentFlowStateConflictError(`${label} belongs to a different source handoff identity`);
  }
}

export function assertSourceHandoffEventTransition(previous, event) {
  const allowed = {
    prepared: new Set(["start-intent", "failure"]),
    "start-intent": new Set(["worker-exited", "failure"]),
    "worker-exited": new Set(["failure", "rollback-intent"]),
    failure: new Set(["rollback-intent"]),
    "rollback-intent": new Set(),
  };
  if (previous === null ? event.kind !== "prepared" : !allowed[previous.kind]?.has(event.kind)) {
    throw new CurrentFlowStateInvariantError("source handoff event transition is invalid");
  }
}

export function assertSourceHandoffSettlementTransition(event, settlement) {
  const compatible = settlement.kind === "accepted" ? event.kind === "worker-exited"
    : settlement.kind === "rolled-back" ? event.kind === "rollback-intent"
      : settlement.kind === "aborted-before-start" ? event.kind === "prepared"
        : event.kind === "failure";
  if (!compatible) throw new CurrentFlowStateInvariantError("source handoff settlement is incompatible with its event head");
}

function assertPublicationActivity({ descriptor, activities, identity, label, allowedOperations = ["publish_artifacts"] }) {
  if (descriptor?.activityId == null) {
    throw new CurrentFlowStateInvariantError(`${label} has no producer Activity`);
  }
  const activity = activities.find((entry) => entry.id === descriptor.activityId) ?? null;
  const taskStageSource = activity?.transition?.operation === "advance_task_review_stage"
    ? activity.transition.taskReviewStagePlan?.facts?.binding ?? null
    : null;
  const attemptBound = taskStageSource === null
    ? activity?.attemptId === identity.attempt.id && activity?.sequence === identity.attempt.sequence
    : taskStageSource.sourceStepId === identity.nodeId
      && taskStageSource.attemptId === identity.attempt.id
      && taskStageSource.attemptSequence === identity.attempt.sequence;
  if (activity === null
    || activity.nodeId !== identity.nodeId
    || !attemptBound
    || !allowedOperations.includes(activity.transition.operation)) {
    throw new CurrentFlowStateInvariantError(`${label} producer Activity does not bind its source Attempt`);
  }
}

/** Complete catalog-backed authority for one source handoff Attempt. */
export class CanonicalSourceHandoffAuthority {
  constructor({ checkpoint, checkpointDescriptor, events, eventDescriptors, settlement = null, settlementDescriptor = null, rollbackBlob, rollbackBlobDescriptor, activities } = {}) {
    if (!(checkpoint instanceof CanonicalSourceHandoffCheckpoint)) throw new CurrentFlowStateInvariantError("source handoff authority requires a typed checkpoint");
    if (!Array.isArray(events) || events.some((entry) => !(entry instanceof SourceHandoffEvent))) throw new CurrentFlowStateInvariantError("source handoff authority requires typed events");
    if (events.length === 0 || events[0].kind !== "prepared") throw new CurrentFlowStateInvariantError("source handoff authority requires its prepared event");
    if (!Buffer.isBuffer(rollbackBlob) || digest(rollbackBlob) !== checkpoint.rollbackBlobDigest) throw new CurrentFlowStateInvariantError("source handoff rollback blob does not match its checkpoint");
    if (events.length !== eventDescriptors.length) throw new CurrentFlowStateInvariantError("source handoff event descriptors are incomplete");
    let previous = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      assertSourceHandoffEventTransition(index === 0 ? null : events[index - 1], event);
      assertSameIdentity(checkpoint.identity, event.identity, "source handoff event");
      if (event.checkpointDigest !== checkpoint.digest || event.sequence !== index + 1 || event.previousDigest !== previous) {
        throw new CurrentFlowStateInvariantError("source handoff event chain is not contiguous");
      }
      previous = event.digest;
      assertPublicationActivity({ descriptor: eventDescriptors[index], activities, identity: checkpoint.identity, label: "source handoff event" });
    }
    if ((settlement === null) !== (settlementDescriptor === null)) throw new CurrentFlowStateInvariantError("source handoff settlement descriptor is incomplete");
    if (settlement !== null) {
      if (!(settlement instanceof SourceHandoffSettlement)) throw new CurrentFlowStateInvariantError("source handoff settlement must be typed");
      assertSameIdentity(checkpoint.identity, settlement.identity, "source handoff settlement");
      if (settlement.checkpointDigest !== checkpoint.digest || settlement.eventDigest !== previous) {
        throw new CurrentFlowStateInvariantError("source handoff settlement does not bind the event head");
      }
      assertSourceHandoffSettlementTransition(events.at(-1), settlement);
      assertPublicationActivity({
        descriptor: settlementDescriptor, activities, identity: checkpoint.identity, label: "source handoff settlement",
        allowedOperations: settlement.kind === "accepted"
          ? ["confirm_attempt", "repair_implementation", "triage_implementation_for_repair", "triage_implementation_no_repair", "complete_task_review_stage", "advance_task_review_stage"]
          : ["publish_artifacts", "fail_attempt"],
      });
    }
    assertPublicationActivity({ descriptor: checkpointDescriptor, activities, identity: checkpoint.identity, label: "source handoff checkpoint" });
    assertPublicationActivity({ descriptor: rollbackBlobDescriptor, activities, identity: checkpoint.identity, label: "source handoff rollback blob" });
    this.checkpoint = checkpoint;
    this.checkpointDescriptor = Object.freeze({ ...checkpointDescriptor });
    this.events = Object.freeze([...events]);
    this.eventDescriptors = Object.freeze(eventDescriptors.map((entry) => Object.freeze({ ...entry })));
    this.settlement = settlement;
    this.settlementDescriptor = settlementDescriptor === null ? null : Object.freeze({ ...settlementDescriptor });
    this.rollbackBlob = Buffer.from(rollbackBlob);
    this.rollbackBlobDescriptor = Object.freeze({ ...rollbackBlobDescriptor });
    this.descriptors = Object.freeze([
      this.checkpointDescriptor, this.rollbackBlobDescriptor, ...this.eventDescriptors,
      ...(this.settlementDescriptor === null ? [] : [this.settlementDescriptor]),
    ]);
    Object.freeze(this);
  }

  get identity() { return this.checkpoint.identity; }
  get event() { return this.events.at(-1); }
  get settled() { return this.settlement !== null; }
}

/** Lock-scoped CAS and capture admission shared by checkpoint, event and settlement writes. */
export class SourceHandoffPersistenceAdmission {
  constructor({ identity, checkpoint = null, expectedCheckpointDigest = null, expectedPreviousEventDigest = null, settlement = null, expectSettlementAbsent = true, validateCapture = false } = {}) {
    this.identity = identity instanceof SourceWorkerHandoffIdentity ? identity : new SourceWorkerHandoffIdentity(identity);
    if (checkpoint !== null && !(checkpoint instanceof CanonicalSourceHandoffCheckpoint)) throw new CurrentFlowStateInvariantError("source handoff admission checkpoint must be typed");
    this.checkpoint = checkpoint;
    this.expectedCheckpointDigest = expectedCheckpointDigest;
    this.expectedPreviousEventDigest = expectedPreviousEventDigest;
    if (settlement !== null && !(settlement instanceof SourceHandoffSettlement)) {
      throw new CurrentFlowStateInvariantError("source handoff admission settlement must be typed");
    }
    if (settlement !== null && !this.identity.matches(settlement.identity)) {
      throw new CurrentFlowStateConflictError("source handoff admission settlement belongs to a different identity");
    }
    this.settlement = settlement;
    this.expectSettlementAbsent = expectSettlementAbsent === true;
    this.validateCapture = validateCapture === true;
    Object.freeze(this);
  }

  assert(view) {
    if (!identityMatchesState(this.identity, view.state)) throw new CurrentFlowStateConflictError("source handoff Attempt changed before canonical publication");
    if (this.validateCapture) {
      if (this.checkpoint === null) throw new CurrentFlowStateInvariantError("source handoff capture admission lacks its checkpoint");
      if (SourceMutationManifest.capture({ baseline: this.checkpoint.baseline }).mutations.length !== 0) {
        throw new CurrentFlowStateConflictError("source changed before handoff checkpoint publication");
      }
      if (this.identity.canonicalGeneration !== sourceHandoffCanonicalGeneration({ state: view.state, activities: view.activities })) {
        throw new CurrentFlowStateConflictError("canonical Flow changed before handoff checkpoint publication");
      }
      this.checkpoint.canonicalObservation.assertTransitionView(view);
      for (const descriptor of view.catalog.artifacts.filter((entry) => entry.logicalKey === CHECKPOINT_KEY)) {
        const stored = parseJSON(view.readCatalogedArtifact(descriptor), "source handoff checkpoint");
        const other = new SourceWorkerHandoffIdentity(stored.identity);
        if (other.storageId === this.identity.storageId) continue;
        if (JSON.stringify(other.flowIdentity.toJSON()) !== JSON.stringify(this.identity.flowIdentity.toJSON())
          || other.attempt.id !== this.identity.attempt.id
          || other.attempt.nodeId !== this.identity.attempt.nodeId
          || other.attempt.sequence !== this.identity.attempt.sequence) continue;
        const otherSettlement = FLOW_ARTIFACT_CONTRACTS.resolve(SETTLEMENT_KEY, { handoffId: other.storageId }).relativePath;
        if (!view.catalog.artifacts.some((entry) => entry.relativePath === otherSettlement)) {
          throw new CurrentFlowStateConflictError("another source handoff is unsettled for the active Attempt");
        }
      }
    } else {
      if (this.checkpoint === null) throw new CurrentFlowStateInvariantError("source handoff admission requires its canonical checkpoint");
      let observation = this.checkpoint.canonicalObservation;
      for (const descriptor of protocolDescriptors(view, this.identity)) {
        if (descriptor.activityId !== null) {
          observation = observation.withAllowedPublication({
            activityId: descriptor.activityId,
            relativePath: descriptor.relativePath,
            digest: descriptor.hash,
          });
        }
      }
      observation.assertTransitionView(view);
    }
    const checkpointPath = FLOW_ARTIFACT_CONTRACTS.resolve(CHECKPOINT_KEY, { handoffId: this.identity.storageId }).relativePath;
    const checkpointDescriptor = view.catalog.artifacts.find((entry) => entry.relativePath === checkpointPath) ?? null;
    if (this.expectedCheckpointDigest !== null) {
      if (checkpointDescriptor === null) {
        throw new CurrentFlowStateConflictError("source handoff checkpoint changed before publication");
      }
      const stored = parseJSON(view.readCatalogedArtifact(checkpointDescriptor), "source handoff checkpoint");
      if (stored.digest !== this.expectedCheckpointDigest) throw new CurrentFlowStateConflictError("source handoff checkpoint changed before publication");
    } else if (!this.validateCapture && checkpointDescriptor !== null) {
      throw new CurrentFlowStateConflictError("source handoff checkpoint already exists");
    }
    const eventDescriptors = view.catalog.artifacts.filter((entry) => entry.logicalKey === EVENT_KEY && entry.relativePath.startsWith(eventPrefix(this.identity)));
    const events = eventDescriptors.map((entry) => SourceHandoffEvent.fromStored(parseJSON(view.readCatalogedArtifact(entry), "source handoff event")))
      .sort((left, right) => left.sequence - right.sequence);
    const head = events.at(-1)?.digest ?? null;
    if (head !== this.expectedPreviousEventDigest) throw new CurrentFlowStateConflictError("source handoff event head changed before append");
    if (this.settlement !== null) {
      assertSourceHandoffSettlementTransition(events.at(-1) ?? null, this.settlement);
    }
    const settlementPath = FLOW_ARTIFACT_CONTRACTS.resolve(SETTLEMENT_KEY, { handoffId: this.identity.storageId }).relativePath;
    if (this.expectSettlementAbsent && view.catalog.artifacts.some((entry) => entry.relativePath === settlementPath)) {
      throw new CurrentFlowStateConflictError("source handoff is already settled");
    }
  }
}

export function sourceHandoffArtifactWrites({ checkpoint = null, rollbackBlob = null, event = null, settlement = null } = {}) {
  const writes = [];
  if (checkpoint !== null) writes.push({ logicalKey: CHECKPOINT_KEY, parameters: { handoffId: checkpoint.identity.storageId }, mediaType: "application/json", bytes: jsonBytes(checkpoint.toJSON()) });
  if (rollbackBlob !== null) {
    const bytes = Buffer.from(rollbackBlob);
    const identity = checkpoint?.identity ?? event?.identity ?? settlement?.identity;
    if (!(identity instanceof SourceWorkerHandoffIdentity)) throw new CurrentFlowStateInvariantError("source handoff rollback blob requires its identity");
    writes.push({ logicalKey: ROLLBACK_BLOB_KEY, parameters: { handoffId: identity.storageId, blobDigest: digest(bytes) }, mediaType: "application/json", bytes });
  }
  if (event !== null) writes.push({ logicalKey: EVENT_KEY, parameters: eventParameters(event), mediaType: "application/json", bytes: jsonBytes(event.toJSON()) });
  if (settlement !== null) writes.push({ logicalKey: SETTLEMENT_KEY, parameters: { handoffId: settlement.identity.storageId }, mediaType: "application/json", bytes: jsonBytes(settlement.toJSON()) });
  return writes;
}

export function readSourceHandoffAuthorityFromView({ view, identity, root, canonicalLocation } = {}) {
  const expected = identity instanceof SourceWorkerHandoffIdentity ? identity : new SourceWorkerHandoffIdentity(identity);
  const checkpointPath = FLOW_ARTIFACT_CONTRACTS.resolve(CHECKPOINT_KEY, { handoffId: expected.storageId }).relativePath;
  const checkpointDescriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === CHECKPOINT_KEY && entry.relativePath === checkpointPath) ?? null;
  if (checkpointDescriptor === null) return null;
  const checkpoint = CanonicalSourceHandoffCheckpoint.fromStored(
    parseJSON(view.readCatalogedArtifact(checkpointDescriptor), "source handoff checkpoint"),
    { root, canonicalLocation },
  );
  assertSameIdentity(expected, checkpoint.identity, "source handoff checkpoint");
  const eventDescriptors = view.catalog.artifacts
    .filter((entry) => entry.logicalKey === EVENT_KEY && entry.relativePath.startsWith(eventPrefix(expected)))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const events = eventDescriptors.map((entry) => SourceHandoffEvent.fromStored(parseJSON(view.readCatalogedArtifact(entry), "source handoff event")));
  const settlementPath = FLOW_ARTIFACT_CONTRACTS.resolve(SETTLEMENT_KEY, { handoffId: expected.storageId }).relativePath;
  const settlementDescriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === SETTLEMENT_KEY && entry.relativePath === settlementPath) ?? null;
  const settlement = settlementDescriptor === null
    ? null
    : SourceHandoffSettlement.fromStored(parseJSON(view.readCatalogedArtifact(settlementDescriptor), "source handoff settlement"));
  const rollbackBlobPath = FLOW_ARTIFACT_CONTRACTS.resolve(ROLLBACK_BLOB_KEY, { handoffId: expected.storageId, blobDigest: checkpoint.rollbackBlobDigest }).relativePath;
  const rollbackBlobDescriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === ROLLBACK_BLOB_KEY && entry.relativePath === rollbackBlobPath) ?? null;
  if (rollbackBlobDescriptor === null) throw new CurrentFlowStateInvariantError("source handoff rollback blob is absent from the catalog");
  return new CanonicalSourceHandoffAuthority({
    checkpoint, checkpointDescriptor: checkpointDescriptor.toJSON(), events,
    eventDescriptors: eventDescriptors.map((entry) => entry.toJSON()), settlement,
    settlementDescriptor: settlementDescriptor?.toJSON() ?? null,
    rollbackBlob: view.readCatalogedArtifact(rollbackBlobDescriptor),
    rollbackBlobDescriptor: rollbackBlobDescriptor.toJSON(), activities: view.activities,
  });
}

export const SOURCE_HANDOFF_LOGICAL_KEYS = Object.freeze({ checkpoint: CHECKPOINT_KEY, event: EVENT_KEY, settlement: SETTLEMENT_KEY, rollbackBlob: ROLLBACK_BLOB_KEY });
