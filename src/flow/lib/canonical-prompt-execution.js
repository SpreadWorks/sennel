import { isDeepStrictEqual } from "node:util";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { PromptExecutionJournalRecord, PromptExecutionJournalSnapshot, PromptExecutionScope, PromptProcessStopObservation } from "../../lib/prompt-execution-journal.js";
import { PromptExecutionBudget, PromptExecutionLimit, responseCharacterCount, responseContentDigest } from "../../lib/prompt-batching.js";
import { AgentTransportFailureObservation } from "../../lib/agent-transport-failure-observation.js";
import { FlowExecutionContract, FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";
import { FlowProcessStopEvidence } from "./process-runtime-evidence.js";
import { CanonicalSpecReview } from "./spec-review-artifacts.js";
import { DraftLifecycle } from "./draft-lifecycle.js";

const zeroBudget = Object.freeze({ providerCallCount: 0, synthesisCallCount: 0, aggregateCharacters: 0, aggregateItemCount: 0 });
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const same = isDeepStrictEqual;
function refuse(message) { throw new FlowExecutionContractRefusal(message); }
function write(logicalKey, parameters, value) { return { logicalKey, parameters, mediaType: "application/json", bytes: bytes(value) }; }
function read(view, logicalKey, parameters) {
  const target = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, parameters);
  const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === logicalKey && entry.relativePath === target.relativePath);
  if (descriptor === undefined) return null;
  const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
  const activity = view.activities.find((entry) => entry.id === descriptor.activityId);
  if (activity === undefined) refuse("Execution artifact has no canonical producer");
  return { document, descriptor, activity };
}
function assertProducer(entry, contract) {
  if (entry.activity?.nodeId !== contract.nodeId || entry.activity?.attemptId !== contract.attemptId
    || entry.activity.sequence !== contract.attemptSequence) refuse("Execution artifact belongs to another producer Attempt");
}
function readEpisodeBudget(view, contract) {
  const entry = read(view, "prompt.execution.budget", { budgetId: contract.budgetId });
  if (entry === null) {
    const prefix = `artifacts/executions/${contract.episodeId}/`;
    if (view.catalog.artifacts.some((descriptor) => ["prompt.execution.event", "prompt.execution.progress"].includes(descriptor.logicalKey)
      && descriptor.relativePath.startsWith(prefix))) refuse("Prompt execution history has no durable episode budget");
    return zeroBudget;
  }
  assertProducer(entry, contract);
  if (entry.document.budgetId !== contract.budgetId) refuse("Prompt budget belongs to another episode");
  const prefix = `artifacts/executions/${contract.episodeId}/`;
  const events = view.catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "prompt.execution.event"
    && descriptor.relativePath.startsWith(prefix));
  const matching = events.filter((descriptor) => descriptor.relativePath.endsWith(`/${entry.document.eventId}.json`));
  const activityOrder = new Map(view.activities.map((activity, index) => [activity.id, index]));
  const latest = [...events].sort((left, right) => activityOrder.get(left.activityId) - activityOrder.get(right.activityId)).at(-1);
  if (matching.length !== 1 || latest?.relativePath !== matching[0].relativePath
    || latest.activityId !== entry.descriptor.activityId) refuse("Prompt budget lacks its latest immutable consumption event");
  const event = JSON.parse(view.readCatalogedArtifact(matching[0]).toString("utf8"));
  if (event.contractId !== entry.document.contractId || !same(event.record.snapshot.budget, entry.document.budget)
    || event.digest !== executionValueDigest(event.record)) refuse("Prompt budget differs from its consumption event");
  const snapshot = PromptExecutionJournalSnapshot.fromJSON(event.record.snapshot);
  return PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(contract.executionLimit ?? {}), snapshot.budget).snapshot();
}
export function executionContractArtifact(contract) {
  if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Execution contract must be typed");
  return write("execution.contract", contract.parameters, { id: contract.id, contract: contract.toJSON() });
}
/** Acquire saved policy before comparing it with separately acquired runtime/input. */
export function readStoredExecutionContractFromView(view, { binding, generation, optional = false }) {
  const parameters = FlowExecutionContract.parametersForBinding({ binding, generation });
  const episodeId = parameters.episodeId;
  const entry = read(view, "execution.contract", parameters);
  if (entry === null) {
    if (optional) return null;
    refuse("Unfinished execution has no canonical contract");
  }
  const stored = FlowExecutionContract.fromJSON(entry.document.contract);
  if (stored.episodeId !== episodeId || stored.generation !== generation || entry.document.id !== stored.id
    || stored.stepId !== binding.stepId || view.state.runId !== binding.runId || view.state.specId !== binding.specId
    || view.state.attempt?.id !== binding.attempt.id || view.state.attempt.sequence !== binding.attempt.sequence) {
    refuse("Saved execution contract does not belong to the requested generation and Attempt");
  }
  assertProducer(entry, stored);
  return stored;
}
export function readExecutionContractFromView(view, contract, { optional = false, current = true } = {}) {
  if (current) contract.assertCurrent(view.state);
  const entry = read(view, "execution.contract", contract.parameters);
  if (entry === null) {
    if (current) for (const baseline of contract.inputBaselines) baseline.assert(view);
    if (optional) return null;
    refuse("Unfinished execution has no canonical contract");
  }
  const stored = FlowExecutionContract.fromJSON(entry.document.contract);
  contract.assertMatches(stored);
  if (entry.document.id !== stored.id) refuse("Execution contract digest is invalid");
  assertProducer(entry, contract);
  if (current) for (const baseline of contract.inputBaselines) assertExecutionInput(view, contract, entry, baseline);
  return stored;
}

/** A saved own publication advances precisely its originally claimed input row. */
function assertExecutionInput(view, contract, claim, baseline) {
  try { baseline.assert(view); return; }
  catch (error) {
    const reviewAdvance = contract.stepId === "spec-review" && baseline.baseline.artifact.logicalKey === "spec.review";
    const draftAdvance = baseline.baseline.artifact.logicalKey === "draft";
    if (error.code !== "FLOW_EXECUTION_INPUT_BASELINE_CHANGED" || !reviewAdvance && !draftAdvance) throw error;
    const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === baseline.baseline.artifact.relativePath);
    const publication = descriptor === undefined ? null : view.activities.find((entry) => entry.id === descriptor.activityId);
    const originalReceipt = claim.activity.result?.draftSettlementReceipt;
    const receipt = publication?.result?.draftSettlementReceipt;
    const originalLifecycle = originalReceipt?.executionLifecycle;
    const lifecycle = receipt?.executionLifecycle;
    error.data = Object.freeze({ ...error.data, publicationPhase: lifecycle?.phase ?? null,
      claimedPhase: originalLifecycle?.phase ?? null, publicationGeneration: lifecycle?.binding.executionGeneration ?? null,
      contractGeneration: contract.generation, publicationResultKind: receipt?.resultKind ?? null,
      claimedResultKind: originalReceipt?.resultKind ?? null });
    error.message += ` [publication ${lifecycle?.phase ?? "none"}/${lifecycle?.binding.executionGeneration ?? "none"}/${receipt?.resultKind ?? "none"}; claim ${originalLifecycle?.phase ?? "none"}/${originalLifecycle?.binding.executionGeneration ?? "none"}/${originalReceipt?.resultKind ?? "none"}]`;
    if (publication?.nodeId !== contract.nodeId || publication.attemptId !== contract.attemptId
      || publication.sequence !== contract.attemptSequence || originalLifecycle?.phase !== "claimed"
      || lifecycle?.phase !== "publication" || lifecycle.binding.executionGeneration !== contract.generation
      || receipt.settlementKind !== "execution" || receipt.resultKind !== originalReceipt.resultKind
      || receipt.resultType !== originalReceipt.resultType
      || (reviewAdvance ? lifecycle.binding.inputDigest : lifecycle.binding.inputRevision) !== contract.inputRevision
      || !same(lifecycle.binding.toJSON?.() ?? lifecycle.binding, originalLifecycle.binding.toJSON?.() ?? originalLifecycle.binding)
      || !same(lifecycle.claim.toJSON?.() ?? lifecycle.claim, originalLifecycle.claim.toJSON?.() ?? originalLifecycle.claim)
      || !view.activities.some((entry) => entry.id === baseline.activityId)) throw error;
    const outputBytes = view.readCatalogedArtifact(descriptor);
    if (reviewAdvance) {
      if (publication.reviewPublication?.stage !== contract.stepId) throw error;
      const review = new CanonicalSpecReview(JSON.parse(outputBytes.toString("utf8")));
      publication.reviewPublication.assertReview(review, { specId: contract.specId,
        revision: review.identity.revision.value, bytes: outputBytes });
      if (review.audit.at(-1)?.inputDigest !== baseline.baseline.digest) throw error;
    } else {
      if (lifecycle.claim.kind !== "worker" || typeof lifecycle.claim.requestDigest !== "string") throw error;
      const references = publication.result.artifactRefs;
      const handoff = references.find((reference) => reference.kind === "worker-handoff");
      if (!references.some((reference) => reference.kind === "worker-handoff-request" && reference.id === lifecycle.claim.requestDigest)
        || handoff === undefined || !publication.references.artifacts.some((reference) => reference.id === handoff.id)
        || new DraftLifecycle(JSON.parse(outputBytes.toString("utf8"))).validateForPublication().length !== 0) throw error;
    }
  }
}
export class ExecutionContractPublicationAdmission {
  constructor(contract, { allowAbsent = true, requireAbsent = false } = {}) { this.contract = contract; this.allowAbsent = allowAbsent; this.requireAbsent = requireAbsent; Object.freeze(this); }
  assert(view) {
    const existing = readExecutionContractFromView(view, this.contract, { optional: this.allowAbsent });
    if (this.requireAbsent && existing !== null) refuse("Execution contract was claimed by another execution");
    const prefix = `artifacts/executions/${this.contract.episodeId}/`;
    for (const descriptor of view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.contract" && entry.relativePath.startsWith(prefix))) {
      const saved = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
      const previous = FlowExecutionContract.fromJSON(saved.contract);
      if (previous.budgetId !== this.contract.budgetId) refuse("Execution generation cannot replace its Attempt budget owner");
      if (previous.executionLimit !== null && (this.contract.executionLimit === null
        || !new PromptExecutionLimit(previous.executionLimit).canContinueWith(new PromptExecutionLimit(this.contract.executionLimit)))) {
        refuse("Execution generation cannot relax its independent execution limits");
      }
    }
  }
}
function scopeParameters(contract, scope) { return { ...contract.parameters, scopeId: executionValueDigest(scope.toJSON()) }; }
function readScopeProgress(view, contract, scope) {
  const parameters = scopeParameters(contract, scope);
  const entry = read(view, "prompt.execution.progress", parameters);
  if (entry === null) {
    const prefix = `artifacts/executions/${parameters.episodeId}/${parameters.generation}/events/${parameters.scopeId}/`;
    if (view.catalog.artifacts.some((descriptor) => descriptor.logicalKey === "prompt.execution.event"
      && descriptor.relativePath.startsWith(prefix))) refuse("Prompt execution history has no latest scope frontier");
  }
  return entry;
}
function assertPromptStopContract(snapshot, contract, checkoutIdentity) {
  for (const batch of snapshot.batches) for (const value of batch.processStops ?? []) {
    const observation = PromptProcessStopObservation.fromJSON(value);
    new FlowProcessStopEvidence(observation.receipt).assertContract(contract).assertCheckout(checkoutIdentity);
  }
}
function assertProgressDocument(entry, contract, scope, checkoutIdentity) {
  assertProducer(entry, contract);
  const document = entry.document;
  if (document.contractId !== contract.id || document.digest !== executionValueDigest(document.record)
    || !Number.isSafeInteger(document.sequence) || document.sequence < 1
    || !same(document.record.scope, scope.toJSON())) refuse("Prompt execution frontier identity is invalid");
  const snapshot = PromptExecutionJournalSnapshot.fromJSON(document.record.snapshot);
  assertPromptStopContract(snapshot, contract, checkoutIdentity);
  return snapshot;
}
export function readPromptExecutionProgressFromView(view, contract, scope, checkoutIdentity = null) {
  if (!(scope instanceof PromptExecutionScope)) throw new TypeError("Prompt progress scope must be typed");
  readExecutionContractFromView(view, contract);
  const entry = readScopeProgress(view, contract, scope);
  if (entry === null) return null;
  const snapshot = assertProgressDocument(entry, contract, scope, checkoutIdentity);
  const immutable = read(view, "prompt.execution.event", { ...scopeParameters(contract, scope), eventId: entry.document.eventId });
  if (immutable === null || !same(immutable.document, entry.document)) refuse("Prompt execution frontier lacks its immutable event");
  assertProducer(immutable, contract);
  const prefix = FLOW_ARTIFACT_CONTRACTS.resolve("prompt.execution.event", { ...scopeParameters(contract, scope), eventId: "sample" }).relativePath.replace(/sample\.json$/, "");
  const events = view.catalog.artifacts.filter((descriptor) => descriptor.logicalKey === "prompt.execution.event"
    && descriptor.relativePath.startsWith(prefix)).map((descriptor) => {
      const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
      const activity = view.activities.find((producer) => producer.id === descriptor.activityId);
      const saved = { document, descriptor, activity };
      assertProgressDocument(saved, contract, scope, checkoutIdentity);
      return document;
    }).sort((left, right) => left.sequence - right.sequence);
  let previousDigest = null;
  for (const [index, document] of events.entries()) {
    if (document.sequence !== index + 1 || document.previousDigest !== previousDigest) refuse("Prompt execution history is not contiguous");
    previousDigest = document.digest;
  }
  if (!same(events.at(-1), entry.document)) refuse("Prompt execution frontier is not its latest immutable event");
  return snapshot;
}
export class CanonicalPromptExecutionEpisode {
  constructor({ executionContract, scopes, budget }) {
    if (!(executionContract instanceof FlowExecutionContract) || !Array.isArray(scopes)
      || scopes.some((scope) => !(scope instanceof PromptExecutionJournalSnapshot))) throw new TypeError("Canonical episode requires typed contract and scope frontiers");
    const ids = scopes.map((snapshot) => executionValueDigest(snapshot.scope.toJSON()));
    if (new Set(ids).size !== ids.length) throw new TypeError("Canonical episode cannot repeat a scope");
    const restoredBudget = PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(executionContract.executionLimit ?? {}), budget);
    for (const scope of scopes) restoredBudget.assertIncludes(scope.budget);
    this.executionContract = executionContract;
    this.scopes = Object.freeze(scopes);
    this.budget = restoredBudget.snapshot();
    this.executionLimit = executionContract.executionLimit;
    this.executionMode = executionContract.executionMode;
    Object.freeze(this);
  }
}
export function readPromptExecutionEpisodeFromView(view, contract, checkoutIdentity = null) {
  readExecutionContractFromView(view, contract);
  const prefix = `artifacts/executions/${contract.episodeId}/${contract.generation}/`;
  const scopeById = new Map();
  for (const entry of view.catalog.artifacts.filter((descriptor) => ["prompt.execution.progress", "prompt.execution.event"].includes(descriptor.logicalKey)
    && descriptor.relativePath.startsWith(prefix))) {
    const document = JSON.parse(view.readCatalogedArtifact(entry).toString("utf8"));
    const scope = PromptExecutionScope.fromJSON(document.record.scope);
    scopeById.set(executionValueDigest(scope.toJSON()), scope);
  }
  const scopes = [...scopeById.values()].map((scope) => readPromptExecutionProgressFromView(view, contract, scope, checkoutIdentity));
  return new CanonicalPromptExecutionEpisode({ executionContract: contract, scopes, budget: readEpisodeBudget(view, contract) });
}
/** State deltas are checked at the persistence boundary, before durable call admission. */
function assertTransition(previous, record, currentBudget) {
  const next = record.snapshot.toJSON();
  if (record.event === "planned") {
    const expected = { ...currentBudget, synthesisCallCount: currentBudget.synthesisCallCount + (next.plan.synthesisCallCount ?? 0) };
    if (previous !== null || !same(next.budget, expected)
      || next.batches.some((entry) => entry.batchCalls !== 0 || entry.claim !== null || entry.responses.length || entry.transportFailures.length || entry.processStops?.length || entry.completion !== null)) refuse("Prompt plan does not begin at the durable budget frontier");
    return;
  }
  if (previous === null || !same(previous.plan, next.plan) || !same(previous.scope, next.scope)
    || !same(previous.budget, currentBudget)) refuse("Prompt execution plan or episode budget changed");
  const changed = next.batches.map((entry, index) => same(entry, previous.batches[index]) ? -1 : index).filter((index) => index >= 0);
  if (changed.length !== 1) refuse("Prompt execution event must advance exactly one batch");
  const index = changed[0], old = previous.batches[index], batch = next.batches[index];
  if (old.completion !== null) refuse("Completed prompt batch cannot be changed");
  const delta = Object.fromEntries(Object.keys(currentBudget).map((key) => [key, next.budget[key] - currentBudget[key]]));
  if (Object.values(delta).some((value) => value < 0)) refuse("Prompt execution cannot reset consumed budget");
  const groupId = next.plan.batches[index].groupId;
  for (const group of next.groups) {
    const prior = previous.groups.find((entry) => entry.groupId === group.groupId);
    if (group.groupId !== groupId && !same(group, prior)) refuse("Prompt event changed an unrelated group");
    if (Object.keys(delta).some((key) => group.budget[key] - prior.budget[key] !== (group.groupId === groupId && key === "providerCallCount" ? delta[key] : 0))) refuse("Prompt group budget differs from its episode consumption");
    const responseDelta = group.groupId === groupId ? batch.batchCalls - old.batchCalls : 0;
    if (group.responseCallCount - prior.responseCallCount !== responseDelta) refuse("Prompt group response count differs from its batch calls");
  }
  const noAggregate = delta.aggregateCharacters === 0 && delta.aggregateItemCount === 0;
  if (record.event !== "process-stopped" && !same(batch.processStops ?? [], old.processStops ?? [])) refuse("Prompt event altered its immutable stop observations");
  if (record.event === "claimed") {
    if (old.claim !== null || batch.claim === null || batch.transportOrdinal !== old.transportOrdinal + 1
      || delta.providerCallCount !== 1 || delta.synthesisCallCount !== 0 || !noAggregate || !same(batch.responses, old.responses)
      || !same(batch.transportFailures, old.transportFailures) || batch.completion !== null
      || ![old.batchCalls, old.batchCalls + 1].includes(batch.batchCalls)) refuse("Provider claim is duplicated or has an invalid budget frontier");
    const failed = old.transportFailures.filter((failure) => failure.responseCallIndex === batch.claim.responseCallIndex).at(-1);
    if (failed !== undefined && (!failed.retryable || batch.claim.attempt !== failed.attempt + 1
      || batch.claim.maxAttempts > failed.maxAttempts || ["requestDigest", "schemaDigest", "providerKey", "profileKey"].some((key) => batch.claim[key] !== failed[key]))) refuse("Provider retry differs from its observed failure");
  } else if (record.event === "process-stopped") {
    const stops = batch.processStops ?? [], oldStops = old.processStops ?? [];
    const { processStops: ignoredOld, ...oldFrontier } = old;
    const { processStops: ignoredNext, ...nextFrontier } = batch;
    if (old.claim === null || !same(oldFrontier, nextFrontier) || stops.length !== oldStops.length + 1
      || !same(stops.slice(0, -1), oldStops) || !same(next.budget, currentBudget)
      || !same(next.groups, previous.groups)) refuse("Process stop observation changed the Prompt claim or budget");
    PromptProcessStopObservation.fromJSON(stops.at(-1)).identity.assertClaim(old.claim);
  } else if (record.event === "transport-failed") {
    if (old.claim === null || batch.claim !== null || batch.transportFailures.length !== old.transportFailures.length + 1
      || !same(batch.transportFailures.slice(0, -1), old.transportFailures)
      || !same(batch.responses, old.responses) || !same(next.budget, currentBudget)) refuse("Transport failure does not observe the current claim");
    if (old.claim.processIdentity && !old.processStops?.some((entry) => entry.identity.transportOrdinal === old.claim.transportOrdinal)) refuse("Transport failure has no durable managed stop observation");
    const failure = batch.transportFailures.at(-1);
    if (["responseCallIndex", "attempt", "maxAttempts", "requestDigest", "schemaDigest", "providerKey", "profileKey"].some((key) => failure[key] !== old.claim[key])) refuse("Transport failure belongs to another claim");
    AgentTransportFailureObservation.fromJSON(failure.observation).assertFailure(failure);
  } else if (record.event === "response") {
    const response = batch.responses.at(-1);
    if (response.origin === "provider" && old.claim?.processIdentity
      && !old.processStops?.some((entry) => entry.identity.transportOrdinal === old.claim.transportOrdinal)) refuse("Provider response has no durable managed stop observation");
    const failure = old.transportFailures.filter((entry) => entry.responseCallIndex === response.responseCallIndex).at(-1);
    const sameCall = (identity) => ["requestDigest", "schemaDigest", "providerKey", "profileKey"]
      .every((key) => identity[key] === response[key]);
    const resumedCache = failure !== undefined && failure.retryable && failure.attempt < failure.maxAttempts
      && sameCall(failure) && batch.batchCalls === old.batchCalls;
    if (batch.claim !== null || batch.responses.length !== old.responses.length + 1
      || !same(batch.responses.slice(0, -1), old.responses) || !same(batch.transportFailures, old.transportFailures)
      || !same(next.budget, currentBudget) || (response.origin === "provider"
        ? old.claim === null || old.claim.responseCallIndex !== response.responseCallIndex || !sameCall(old.claim)
        : old.claim !== null || batch.batchCalls !== old.batchCalls + 1 && !resumedCache)) refuse("Prompt response does not belong to its durable call");
  } else if (record.event === "validated") {
    if (old.claim !== null || batch.claim !== null || batch.completion === null || old.responses.length === 0
      || !same(batch.responses, old.responses) || !same(batch.transportFailures, old.transportFailures)
      || delta.providerCallCount !== 0 || delta.synthesisCallCount !== 0
      || delta.aggregateCharacters !== batch.completion.responseCharacters
      || delta.aggregateItemCount !== batch.completion.responseItemCount) refuse("Prompt validation differs from its saved response and accounting");
  }
  if (record.event !== "claimed" && record.event !== "response"
    && (batch.batchCalls !== old.batchCalls || batch.transportOrdinal !== old.transportOrdinal)) refuse("Prompt observation changed its call identity");
  if (record.event === "response" && batch.transportOrdinal !== old.transportOrdinal) refuse("Prompt response changed its transport identity");
}
export class PromptExecutionProgressPublication {
  constructor({ contract, scope, record, expectedSnapshotDigest, operationId, expectedCheckoutIdentity = null }) {
    if (!(contract instanceof FlowExecutionContract) || !(scope instanceof PromptExecutionScope)
      || !(record instanceof PromptExecutionJournalRecord) || !same(scope.toJSON(), record.scope.toJSON())) throw new TypeError("Prompt persistence requires typed execution inputs");
    Object.assign(this, { contract, scope, record, expectedSnapshotDigest, operationId, expectedCheckoutIdentity });
    Object.freeze(this);
  }
  prepare(view) {
    readExecutionContractFromView(view, this.contract);
    const parameters = scopeParameters(this.contract, this.scope);
    const previous = readScopeProgress(view, this.contract, this.scope);
    const snapshot = previous === null ? null : assertProgressDocument(previous, this.contract, this.scope, this.expectedCheckoutIdentity).toJSON();
    if ((snapshot === null ? null : executionValueDigest(snapshot)) !== this.expectedSnapshotDigest) refuse("Prompt execution scope frontier changed before save");
    const budget = readEpisodeBudget(view, this.contract);
    assertPromptStopContract(this.record.snapshot, this.contract, this.expectedCheckoutIdentity);
    assertTransition(snapshot, this.record, budget);
    if (this.contract.executionLimit !== null) {
      const limit = new PromptExecutionLimit(this.contract.executionLimit);
      PromptExecutionBudget.fromSnapshot(limit, this.record.snapshot.budget);
      if (this.record.snapshot.batches.length > limit.maxBatchCount) refuse("Prompt plan exceeds its fixed batch limit");
      for (const batch of this.record.snapshot.batches) {
        if (batch.batchCalls > limit.maxProtocolRetryCount + 1) refuse("Prompt call exceeds its fixed protocol limit");
        for (const response of batch.responses) {
          if (response.rejection === null) {
            if (responseContentDigest(response.raw) !== response.responseDigest
              || responseCharacterCount(response.raw) !== response.responseCharacters
              || limit.maxResponseCharacters !== null && response.responseCharacters > limit.maxResponseCharacters) refuse("Saved prompt response exceeds its fixed bound or differs from its bytes");
          } else if (response.raw !== null || limit.maxResponseCharacters === null
            || response.responseCharacters <= limit.maxResponseCharacters) refuse("Prompt response rejection does not observe an oversized response");
        }
      }
    }
    const document = { contractId: this.contract.id, sequence: (previous?.document.sequence ?? 0) + 1,
      previousDigest: previous?.document.digest ?? null, eventId: this.operationId,
      digest: executionValueDigest(this.record.toJSON()), record: this.record.toJSON() };
    return { document, writes: [write("prompt.execution.event", { ...parameters, eventId: this.operationId }, document),
      write("prompt.execution.progress", parameters, document),
      write("prompt.execution.budget", { budgetId: this.contract.budgetId }, { budgetId: this.contract.budgetId,
        contractId: this.contract.id, eventId: this.operationId, budget: this.record.snapshot.budget })] };
  }
  assert(view) { this.prepare(view); }
  readAcknowledgement(view) {
    const saved = read(view, "prompt.execution.event", { ...scopeParameters(this.contract, this.scope), eventId: this.operationId });
    if (saved === null) return false;
    assertProducer(saved, this.contract);
    if (saved.document.contractId !== this.contract.id || !same(saved.document.record, this.record.toJSON())) refuse("Prompt save acknowledgement belongs to another event");
    return true;
  }
}
