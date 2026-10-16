import { FlowExecutionSourceManifest, FlowExecutionObservationFact } from "../../lib/flow-execution-observation.js";
import { isDeepStrictEqual } from "node:util";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { PromptExecutionJournalRecord, PromptExecutionJournalSnapshot, PromptExecutionScope, PromptProcessStopObservation,
  PromptExecutionReservationContinuation, PromptResponseExecutionObservation } from "../../lib/prompt-execution-journal.js";
import { PromptExecutionBudget, PromptExecutionLimit, responseCharacterCount, responseContentDigest } from "../../lib/prompt-batching.js";
import { AgentTransportFailureObservation } from "../../lib/agent-transport-failure-observation.js";
import { ProcessExecutionRecoveryEvidence } from "../../lib/process-execution-runtime.js";
import { ProcessExecutionBinding, ProcessExecutionRecoveryCall, ProcessExecutionNonExecutionEvidence,
  ProcessExecutionCheckoutIdentity, executionValueDigest as processEvidenceDigest } from "../../lib/process-execution-values.js";
import { FlowExecutionContract, FlowExecutionContractRefusal, executionValueDigest } from "./flow-execution-contract.js";
import { ArtifactWorkerInputContinuation } from "./artifact-worker-input-continuation.js";
import { ArtifactWorkerRecoveryReceipt } from "./artifact-worker-recovery-values.js";
import { OriginalArtifactWorkerAuthorization } from "./original-artifact-worker-authorization.js";
import { assertArtifactWorkerRequestUnsealed, readArtifactWorkerRequestSnapshotFromView } from "./artifact-worker-execution-recovery.js";
import { WorkerArtifactHandoffRequest } from "./worker-artifact-handoff.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
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
function savedEpisodeContracts(view, contract) {
  const prefix = `artifacts/executions/${contract.episodeId}/`;
  return view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.contract"
    && entry.relativePath.startsWith(prefix)).map((descriptor) => {
    const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
    const saved = FlowExecutionContract.fromJSON(document.contract);
    readExecutionContractFromView(view, saved, { current: false });
    if (saved.episodeId !== contract.episodeId || saved.budgetId !== contract.budgetId) {
      refuse("Prompt history changed its canonical episode or budget owner");
    }
    return saved;
  });
}
/** Historical reads authenticate retained checkouts against immutable registered sources. */
class HistoricalPromptCheckoutAuthority {
  constructor(view) {
    this.sources = view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.source.manifest").map((descriptor) => {
      const manifest = FlowExecutionSourceManifest.fromJSON(JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8")));
      return manifest.assertVersion(view.state);
    });
    this.checkouts = this.sources.filter((manifest) => manifest.checkoutIdentity !== null)
      .map((manifest) => new ProcessExecutionCheckoutIdentity(manifest.checkoutIdentity));
    this.facts = view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.observation")
      .map((descriptor) => FlowExecutionObservationFact.fromJSON(JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"))));
  }
  assertReceiver(observation) {
    const start = this.facts.find((fact) => fact.kind === "agent-started" && fact.entityId === observation.logicalInvocationId
      && same(fact.binding.toJSON(), observation.binding.toJSON()));
    if (!start || start.data.requestId !== observation.requestId
      || start.data.requested?.provider !== observation.providerKey || start.data.requested?.profileKey !== observation.profileKey) refuse("Prompt receiver has no matching logical start observation");
    const prompt = start.data.promptIdentity;
    if (!prompt || !same(prompt, { scope: observation.scope.toJSON(), planDigest: observation.planDigest,
      batchDigest: observation.batchDigest, responseCallIndex: observation.responseCallIndex,
      requestDigest: observation.requestDigest, schemaDigest: observation.schemaDigest })) {
      refuse("Prompt receiver differs from its logical start input identity");
    }
    if (!this.sources.some((manifest) => manifest.id === start.sourceId)) refuse("Prompt receiver has no registered logical source");
  }

  assertIdentity(identity) {
    if (!this.checkouts.some((registered) => registered.matches(identity))) refuse("Prompt history checkout has no registered immutable source");
  }
}

function physicalConsumptionRecord(view, document, contract, checkoutIdentity) {
  const record = document.record;
  if (record.event !== "physical-accounted" || document.contractId !== contract.id
    || record.budgetId !== contract.budgetId || document.digest !== executionValueDigest(record)) {
    refuse("Physical Prompt consumption differs from its immutable execution event");
  }
  const { id, digest, ...summary } = record.physicalEvidence;
  if (id !== digest || digest !== processEvidenceDigest(summary)
    || !FlowProcessExecutionBinding.forEpisode(contract).matches(new ProcessExecutionBinding(summary.binding))) {
    refuse("Physical Prompt consumption has invalid episode inventory evidence");
  }
  const checkout = new ProcessExecutionCheckoutIdentity(summary.checkoutIdentity);
  if (checkoutIdentity instanceof HistoricalPromptCheckoutAuthority) checkoutIdentity.assertIdentity(checkout);
  else if (checkoutIdentity !== null && !checkout.matches(checkoutIdentity)) refuse("Physical Prompt consumption belongs to another checkout");
  const calls = record.calls.map((call) => new ProcessExecutionRecoveryCall(call));
  if (!same(calls.map((call) => call.toJSON()), summary.calls)) refuse("Physical Prompt calls differ from their inventory observation");
  if (calls.length === 0) {
    if (summary.nonExecution === null) refuse("Empty physical Prompt history has no non-execution proof");
    const absence = new ProcessExecutionNonExecutionEvidence(summary.nonExecution);
    if (!same(absence.binding.toJSON(), summary.binding) || !absence.checkoutIdentity.matches(checkout)
      || absence.inventoryDigest !== summary.inventoryDigest) refuse("Physical Prompt non-execution proof differs from its inventory");
  } else if (summary.nonExecution !== null) refuse("Physical Prompt inventory contradicts its non-execution proof");
  const contracts = savedEpisodeContracts(view, contract);
  const seen = new Set();
  for (const call of calls) {
    const key = `${call.executionId}/${call.callId}`;
    if (seen.has(key)) refuse("Physical Prompt consumption repeats a call reservation");
    seen.add(key);
    const owner = contracts.find((entry) => entry.id === call.binding.value.executionContractId);
    if (owner === undefined) refuse("Physical Prompt call has no canonical execution contract in this episode");
    new FlowProcessStopEvidence(call.receipt).assertContract(owner).assertCheckout(checkout);
  }
  if (!Array.isArray(record.accountedCallIds) || new Set(record.accountedCallIds).size !== record.accountedCallIds.length
    || record.accountedCallIds.some((key) => !seen.has(key))) refuse("Physical Prompt accounting has an invalid call frontier");
  const unobserved = calls.filter((call) => call.startPermitted && !record.accountedCallIds.includes(`${call.executionId}/${call.callId}`))
    .map((call) => `${call.executionId}/${call.callId}`);
  if (record.aggregateAccounting !== "validated-responses-only" || !same(record.unobservedProviderUsageCallIds, unobserved)) {
    refuse("Physical Prompt accounting omitted its unobserved provider usage");
  }
  const previous = PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(contract.executionLimit ?? {}), record.previousBudget);
  for (const call of calls) if (call.startPermitted && !record.accountedCallIds.includes(`${call.executionId}/${call.callId}`)) previous.consumeProviderCall();
  if (!same(previous.snapshot(), record.budget)) refuse("Physical Prompt accounting changed an unrelated budget counter");
  for (const kind of ["semantic", "tooling"]) if (!Number.isSafeInteger(record.attemptConsumption[kind])
    || record.attemptConsumption[kind] < 0) refuse("Physical Prompt accounting has invalid Attempt consumption");
  return record;
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
  const owner = savedEpisodeContracts(view, contract).find((saved) => saved.id === event.contractId);
  if (owner === undefined) refuse("Prompt budget event has no canonical execution contract");
  const observed = event.record.event === "physical-accounted"
    ? physicalConsumptionRecord(view, event, owner, null).budget
    : PromptExecutionJournalSnapshot.fromJSON(event.record.snapshot).budget;
  if (event.contractId !== entry.document.contractId || !same(observed, entry.document.budget)
    || event.digest !== executionValueDigest(event.record)) refuse("Prompt budget differs from its consumption event");
  return PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(contract.executionLimit ?? {}), observed).snapshot();
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
function assertStoredPromptStop(receipt, contract, checkoutIdentity) {
  const evidence = new FlowProcessStopEvidence(receipt).assertContract(contract);
  if (checkoutIdentity instanceof HistoricalPromptCheckoutAuthority) checkoutIdentity.assertIdentity(evidence.receipt.checkoutIdentity);
  else evidence.assertCheckout(checkoutIdentity);
}
function assertPromptStopContract(snapshot, contract, checkoutIdentity) {
  for (const batch of snapshot.batches) for (const value of batch.processStops ?? []) {
    const observation = PromptProcessStopObservation.fromJSON(value);
    assertStoredPromptStop(observation.receipt, contract, checkoutIdentity);
  }
  for (const batch of snapshot.batches) if (batch.reservationContinuation !== undefined) {
    const continuation = PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
    if (continuation.executionContractId !== contract.id) refuse("Prompt reservation continuation changed its canonical contract");
    FlowProcessExecutionBinding.forContract(contract, {
      baseBinding: new ProcessExecutionBinding(continuation.physicalEvidence.binding) });
    const savedCheckout = new ProcessExecutionCheckoutIdentity(continuation.physicalEvidence.checkoutIdentity);
    if (checkoutIdentity instanceof HistoricalPromptCheckoutAuthority) checkoutIdentity.assertIdentity(savedCheckout);
    else if (checkoutIdentity !== null && !savedCheckout.matches(checkoutIdentity)) {
      refuse("Prompt reservation continuation changed its checkout identity");
    }
    for (const call of continuation.calls) {
      assertStoredPromptStop(call.receipt, contract, checkoutIdentity);
    }
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
  return readAuthenticatedPromptExecutionProgressFromView(view, contract, scope, checkoutIdentity);
}
function readAuthenticatedPromptExecutionProgressFromView(view, contract, scope, checkoutIdentity) {
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
  /** A budget preview, never authority to start or to adopt another runtime. */
  continuationFor(nextContract, { inputContinuation = null } = {}) {
    return new CanonicalPromptExecutionContinuation({ episode: this, nextContract, inputContinuation });
  }
  get pendingReservationContinuations() {
    return Object.freeze(this.scopes.flatMap((scope) => scope.batches)
      .filter((batch) => batch.reservationContinuation?.consumedClaim === null)
      .map((batch) => PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation)));
  }
}
export class CanonicalPromptExecutionContinuation {
  constructor({ episode, nextContract, inputContinuation = null }) {
    if (!(episode instanceof CanonicalPromptExecutionEpisode) || !(nextContract instanceof FlowExecutionContract)) {
      throw new TypeError("Prompt continuation requires its saved episode and next execution contract");
    }
    const previous = episode.executionContract;
    const { generation: previousGeneration, runtimeRevision: previousRuntime, ...previousPolicy } = previous.toJSON();
    const { generation: nextGeneration, runtimeRevision: nextRuntime, ...nextPolicy } = nextContract.toJSON();
    if (inputContinuation !== null) {
      if (!(inputContinuation instanceof ArtifactWorkerInputContinuation)) throw new TypeError("Prompt input continuation must be typed");
      inputContinuation.assertContracts(previous, nextContract);
      previousPolicy.inputRevision = nextPolicy.inputRevision;
    }
    if (nextGeneration !== previousGeneration + 1 || !same(previousPolicy, nextPolicy)) {
      const fields = [...(nextGeneration === previousGeneration + 1 ? [] : ["generation"]),
        ...Object.keys(previousPolicy).filter((field) => !same(previousPolicy[field], nextPolicy[field]))];
      const error = new FlowExecutionContractRefusal(`Prompt continuation must preserve its episode, inputs, authority and execution limits: ${fields.join(", ")}`);
      error.mismatchedFields = Object.freeze(fields);
      throw error;
    }
    const budget = PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(nextContract.executionLimit ?? {}), episode.budget);
    budget.assertCanExecute(1);
    this.previousExecutionContract = previous;
    this.executionContract = nextContract;
    this.budget = budget.snapshot();
    this.remainingProviderCalls = budget.limit.maxProviderCallCount - budget.providerCallCount;
    this.inputContinuation = inputContinuation;
    Object.freeze(this);
  }
  createExecutionBudget() {
    return PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(this.executionContract.executionLimit ?? {}), this.budget);
  }
}
export function readPromptExecutionEpisodeFromView(view, contract, checkoutIdentity = null) {
  readExecutionContractFromView(view, contract);
  return readAuthenticatedPromptExecutionEpisodeFromView(view, contract, checkoutIdentity);
}
/** Saved runtime policy is evidence only; normal execution retains assertCurrent. */
export function readStoredPromptExecutionEpisodeFromView(view, contract, checkoutIdentity = null, { currentAttempt = true } = {}) {
  if (!(contract instanceof FlowExecutionContract)) throw new TypeError("Stored Prompt episode requires its typed execution contract");
  if (view.state.runId !== contract.runId || view.state.specId !== contract.specId) refuse("Stored Prompt episode belongs to another Flow");
  const stored = currentAttempt
    ? readStoredExecutionContractFromView(view, { binding: { runId: contract.runId,
      specId: contract.specId, stepId: contract.stepId, nodeId: contract.nodeId,
      attempt: { id: contract.attemptId, sequence: contract.attemptSequence } }, generation: contract.generation })
    : readExecutionContractFromView(view, contract, { current: false });
  contract.assertMatches(stored);
  return readAuthenticatedPromptExecutionEpisodeFromView(view, stored, checkoutIdentity);
}
function readAuthenticatedPromptExecutionEpisodeFromView(view, contract, checkoutIdentity) {
  const prefix = `artifacts/executions/${contract.episodeId}/${contract.generation}/`;
  const scopeById = new Map();
  for (const entry of view.catalog.artifacts.filter((descriptor) => ["prompt.execution.progress", "prompt.execution.event"].includes(descriptor.logicalKey)
    && descriptor.relativePath.startsWith(prefix))) {
    const document = JSON.parse(view.readCatalogedArtifact(entry).toString("utf8"));
    if (document.record.event === "physical-accounted") {
      if (entry.logicalKey !== "prompt.execution.event") refuse("Physical Prompt accounting cannot replace a scope frontier");
      physicalConsumptionRecord(view, document, contract, checkoutIdentity);
      continue;
    }
    const scope = PromptExecutionScope.fromJSON(document.record.scope);
    scopeById.set(executionValueDigest(scope.toJSON()), scope);
  }
  const scopes = [...scopeById.values()].map((scope) => readAuthenticatedPromptExecutionProgressFromView(view, contract, scope, checkoutIdentity));
  return new CanonicalPromptExecutionEpisode({ executionContract: contract, scopes, budget: readEpisodeBudget(view, contract) });
}

function assertPromptReceiverContract(observation, contract, flowVersionId) {
  const binding = observation.binding;
  if (binding.flowVersionId !== flowVersionId || binding.runId !== contract.runId
    || binding.specId !== contract.specId || binding.nodeId !== contract.nodeId || binding.taskId !== contract.taskId
    || binding.attemptId !== contract.attemptId || binding.attemptSequence !== contract.attemptSequence
    || binding.executionContractId !== contract.id || binding.executionGeneration !== contract.generation) {
    refuse("Prompt receiver observation belongs to another execution binding");
  }
}

/** Verify selected receiver evidence under the existing canonical publication lock. */
export function assertPromptResponseSelectionFromView(view, selection) {
  const authority = new HistoricalPromptCheckoutAuthority(view);
  const episode = readStoredPromptExecutionEpisodeFromView(view, selection.executionContract,
    authority, { currentAttempt: false });
  selection.assertEpisode(episode, view.state);
  for (const response of selection.receivedResponses) authority.assertReceiver(response);
}

function promptReceiverContractsFromView(view) {
  const contracts = new Set();
  for (const descriptor of view.catalog.artifacts.filter((entry) => ["prompt.execution.event", "prompt.execution.progress"].includes(entry.logicalKey))) {
    const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
    if (document.digest !== executionValueDigest(document.record) || !Number.isSafeInteger(document.sequence)
      || document.sequence < 1) refuse("Prompt execution history event identity is invalid");
    if (document.record.event === "physical-accounted") continue;
    const snapshot = PromptExecutionJournalSnapshot.fromJSON(document.record.snapshot);
    const record = new PromptExecutionJournalRecord({ event: document.record.event, snapshot });
    if (!same(record.toJSON(), document.record)) refuse("Prompt execution history record is invalid");
    if (snapshot.batches.some((batch) => batch.responses.some((response) => response.executionObservation !== undefined))) {
      contracts.add(document.contractId);
    }
  }
  return contracts;
}


/** Pure historical receiver capture over a catalog-verified canonical view. */
export function capturePromptExecutionReceiversFromView(view) {
  const observations = [];
  const seen = new Set();
  const checkoutAuthority = new HistoricalPromptCheckoutAuthority(view);
  const contractsWithReceivers = promptReceiverContractsFromView(view);
  const missingContracts = new Set(contractsWithReceivers);
  for (const descriptor of view.catalog.artifacts.filter((entry) => entry.logicalKey === "execution.contract")) {
    const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
    const contract = FlowExecutionContract.fromJSON(document.contract);
    if (!contractsWithReceivers.has(contract.id)) continue;
    missingContracts.delete(contract.id);
    const episode = readStoredPromptExecutionEpisodeFromView(view, contract, checkoutAuthority, { currentAttempt: false });
    for (const snapshot of episode.scopes) for (const batch of snapshot.batches) for (const response of batch.responses) {
      if (response.executionObservation === undefined) continue;
      const observation = PromptResponseExecutionObservation.fromJSON(response.executionObservation)
        .assertResponse({ scope: snapshot.scope, planDigest: snapshot.plan.digest, batchDigest: batch.batchDigest, response });
      assertPromptReceiverContract(observation, contract, view.state.flowVersionId);
      checkoutAuthority.assertReceiver(observation);
      const identity = executionValueDigest(observation.toJSON());
      if (seen.has(identity)) refuse("Prompt receiver observation repeats in canonical history");
      seen.add(identity);
      observations.push(observation);
    }
  }
  if (missingContracts.size > 0) refuse("Prompt receiver lost its canonical execution contract");
  return Object.freeze(observations);
}

/** Import only authenticated physical calls missing from the existing Prompt journal. */
export class LegacyArtifactPromptConsumptionPublication {
  #preparedDigest = null;
  constructor({ contract, physicalEvidence, operationId, expectedCheckoutIdentity = physicalEvidence?.checkoutIdentity }) {
    if (!(contract instanceof FlowExecutionContract) || !(physicalEvidence instanceof ProcessExecutionRecoveryEvidence)
      || !(expectedCheckoutIdentity instanceof ProcessExecutionCheckoutIdentity)
      || typeof operationId !== "string" || !operationId) {
      throw new TypeError("Physical Prompt accounting requires its typed canonical and runtime evidence");
    }
    Object.assign(this, { contract, physicalEvidence, operationId, expectedCheckoutIdentity });
    Object.freeze(this);
  }
  prepare(view) {
    this.physicalEvidence.assertBinding(FlowProcessExecutionBinding.forEpisode(this.contract));
    if (!this.physicalEvidence.checkoutIdentity.matches(this.expectedCheckoutIdentity)) refuse("Physical Prompt accounting changed checkout authority");
    const source = readStoredPromptExecutionEpisodeFromView(view, this.contract, this.expectedCheckoutIdentity);
    const contracts = savedEpisodeContracts(view, this.contract);
    if (contracts.some((contract) => contract.generation > this.contract.generation)) refuse("Physical Prompt accounting has a stale execution generation");
    const episodes = contracts.map((contract) => readAuthenticatedPromptExecutionEpisodeFromView(view, contract, this.expectedCheckoutIdentity));
    const accounted = new Set();
    const claims = [];
    for (const episode of episodes) for (const snapshot of episode.scopes) for (const batch of snapshot.batches) {
      if (batch.claim?.processIdentity != null) claims.push({ contractId: episode.executionContract.id, identity: batch.claim.processIdentity });
      for (const stopped of batch.processStops ?? []) accounted.add(`${stopped.receipt.executionId}/${stopped.receipt.callId}`);
    }
    const prefix = `artifacts/executions/${this.contract.episodeId}/`;
    for (const descriptor of view.catalog.artifacts.filter((entry) => entry.logicalKey === "prompt.execution.event"
      && entry.relativePath.startsWith(prefix))) {
      const event = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
      if (event.record.event !== "physical-accounted") continue;
      const owner = contracts.find((contract) => contract.id === event.contractId);
      if (owner === undefined) refuse("Physical Prompt accounting event lost its execution contract");
      const record = physicalConsumptionRecord(view, event, owner, this.expectedCheckoutIdentity);
      for (const call of record.calls) accounted.add(`${call.executionId}/${call.callId}`);
    }
    const calls = this.physicalEvidence.calls;
    for (const call of calls) if (claims.some(({ contractId, identity }) => contractId === call.binding.value.executionContractId
      && identity.providerAttemptId === call.invocation?.providerAttemptId
      && identity.logicalInvocationId === call.invocation?.logicalInvocationId)) accounted.add(`${call.executionId}/${call.callId}`);
    const scopeId = executionValueDigest(["physical-accounted", this.contract.id]);
    const parameters = { ...this.contract.parameters, scopeId, eventId: this.operationId };
    const saved = read(view, "prompt.execution.event", parameters);
    if (saved !== null) {
      assertProducer(saved, this.contract);
      const record = physicalConsumptionRecord(view, saved.document, this.contract, this.expectedCheckoutIdentity);
      if (!same(record.physicalEvidence, this.physicalEvidence.toJSON())) refuse("Physical Prompt accounting replay changed its inventory");
      return this.#prepared({ writes: [], episode: source, document: saved.document });
    }
    const budget = PromptExecutionBudget.fromSnapshot(new PromptExecutionLimit(this.contract.executionLimit ?? {}), source.budget);
    for (const call of calls) if (call.startPermitted && !accounted.has(`${call.executionId}/${call.callId}`)) budget.consumeProviderCall();
    const record = { event: "physical-accounted", budgetId: this.contract.budgetId,
      physicalEvidence: this.physicalEvidence.toJSON(), calls: calls.map((call) => ({ executionId: call.executionId,
        callId: call.callId, ownerEpoch: call.ownerEpoch, binding: call.binding.toJSON(), invocation: call.invocation,
        startPermitted: call.startPermitted, receipt: call.receipt.toJSON() })),
      accountedCallIds: calls.map((call) => `${call.executionId}/${call.callId}`).filter((key) => accounted.has(key)),
      previousBudget: source.budget, budget: budget.snapshot(),
      aggregateAccounting: "validated-responses-only",
      unobservedProviderUsageCallIds: calls.filter((call) => call.startPermitted && !accounted.has(`${call.executionId}/${call.callId}`))
        .map((call) => `${call.executionId}/${call.callId}`),
      attemptConsumption: { semantic: view.state.attempt.consumption.semantic, tooling: view.state.attempt.consumption.tooling } };
    const document = { contractId: this.contract.id, sequence: 1, previousDigest: null,
      eventId: this.operationId, digest: executionValueDigest(record), record };
    physicalConsumptionRecord(view, document, this.contract, this.expectedCheckoutIdentity);
    return this.#prepared({ document, episode: new CanonicalPromptExecutionEpisode({ executionContract: this.contract,
      scopes: source.scopes, budget: budget.snapshot() }),
    writes: [write("prompt.execution.event", parameters, document),
      write("prompt.execution.budget", { budgetId: this.contract.budgetId }, { budgetId: this.contract.budgetId,
        contractId: this.contract.id, eventId: this.operationId, budget: budget.snapshot() })] });
  }
  #prepared(value) {
    if (this.#preparedDigest !== null && this.#preparedDigest !== value.document.digest) {
      refuse("Physical Prompt budget or Attempt changed before save");
    }
    this.#preparedDigest = value.document.digest;
    return value;
  }
  assert(view) { this.prepare(view); }
}

/** Reconcile one unused reservation under the existing replacement authorization. */
export class CanonicalPromptReservationReconciliationPublication {
  constructor({ contract, scope, snapshot, recoveryReceipt = null, originalAuthorization = null, request, physicalEvidence, operationId }) {
    if (!(contract instanceof FlowExecutionContract) || !(scope instanceof PromptExecutionScope)
      || !(snapshot instanceof PromptExecutionJournalSnapshot)
      || recoveryReceipt !== null && !(recoveryReceipt instanceof ArtifactWorkerRecoveryReceipt)
      || originalAuthorization !== null && !(originalAuthorization instanceof OriginalArtifactWorkerAuthorization)
      || (recoveryReceipt === null) === (originalAuthorization === null)
      || !(request instanceof WorkerArtifactHandoffRequest)
      || !(physicalEvidence instanceof ProcessExecutionRecoveryEvidence) || typeof operationId !== "string" || !operationId) {
      throw new TypeError("Prompt reservation reconciliation requires its canonical authorization, snapshot and physical evidence");
    }
    (recoveryReceipt?.targetContract ?? originalAuthorization.executionContract).assertMatches(contract);
    if (!same(snapshot.scope.toJSON(), scope.toJSON()) || snapshot.batches.filter((batch) => batch.claim !== null).length !== 1) {
      refuse("Prompt reservation reconciliation requires one exact unresolved scope claim");
    }
    Object.assign(this, { contract, scope, snapshot, recoveryReceipt, originalAuthorization, request, physicalEvidence, operationId });
    Object.freeze(this);
  }
  get authorizationId() { return (this.recoveryReceipt ?? this.originalAuthorization).id; }
  assertEvidence(view) {
    readExecutionContractFromView(view, this.contract);
    this.contract.assertMatches(this.request.executionContract);
    const requestSnapshot = readArtifactWorkerRequestSnapshotFromView(view, { executionContract: this.contract });
    if (requestSnapshot.requestDigest !== this.request.requestDigest
      || this.recoveryReceipt !== null && this.recoveryReceipt.evidence.targetRequestDigest !== requestSnapshot.requestDigest) {
      refuse("Prompt reservation differs from its exact canonical worker request");
    }
    const authorization = read(view, this.recoveryReceipt === null ? "execution.request" : "execution.recovery", this.contract.parameters);
    if (this.recoveryReceipt !== null) {
      if (authorization === null || authorization.document.id !== this.recoveryReceipt.id
        || !same(authorization.document.receipt, this.recoveryReceipt.toJSON())) refuse("Prompt reservation has no exact canonical recovery authorization");
    } else {
      const original = this.originalAuthorization;
      const claim = read(view, "execution.contract", this.contract.parameters);
      if (authorization === null || claim === null || authorization.document.id !== original.requestSnapshot.id
        || !same(authorization.document.snapshot, original.requestSnapshot.toJSON())
        || authorization.descriptor.activityId !== claim.descriptor.activityId
        || this.request.executionContract.id !== this.contract.id || this.request.requestDigest !== original.requestDigest) {
        refuse("Prompt reservation has no exact original claim and request producer");
      }
    }
    assertArtifactWorkerRequestUnsealed(this.request, requestSnapshot);
    assertProducer(authorization, this.contract);
    const batch = this.snapshot.batches.find((entry) => entry.claim !== null);
    const identity = batch.claim.processIdentity;
    if (identity === undefined) refuse("Prompt reservation has no durable physical invocation identity");
    const physical = this.physicalEvidence.forBinding(FlowProcessExecutionBinding.forContract(this.contract))
      .forInvocation({ providerAttemptId: identity.providerAttemptId, logicalInvocationId: identity.logicalInvocationId });
    physical.assertCurrent();
    if (physical.calls.some((call) => call.startPermitted)) refuse("Prompt reservation already received physical start permission");
    const proof = { physicalEvidence: physical.toJSON(), calls: physical.calls.map((call) => ({ executionId: call.executionId,
      callId: call.callId, ownerEpoch: call.ownerEpoch, binding: call.binding.toJSON(), invocation: call.invocation,
      startPermitted: call.startPermitted, receipt: call.receipt.toJSON() })) };
    const previous = batch.reservationContinuation === undefined ? null
      : PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
    if (previous !== null && previous.authorizationId !== this.authorizationId) refuse("Prompt reservation changed its original execution authorization");
    return previous !== null && !previous.pending ? previous.reconcile(proof)
      : new PromptExecutionReservationContinuation({ authorizationId: this.authorizationId,
        executionContractId: this.contract.id, previousClaim: batch.claim, history: previous?.history ?? [], ...proof });
  }
  assertInputCurrent({ flowManager, state }) {
    this.request.assertInputCurrent(state, { flowManager });
    this.request.assertUnpublished({ flowManager, state });
  }
  prepare(view) {
    const continuation = this.assertEvidence(view);
    const current = readPromptExecutionProgressFromView(view, this.contract, this.scope, this.physicalEvidence.checkoutIdentity);
    const batch = current?.batches.find((entry) => entry.claim !== null);
    if (batch?.reservationContinuation !== undefined) {
      const saved = PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
      if (saved.authorizationId !== this.authorizationId) refuse("Prompt reservation continuation changed its execution authorization");
      if (saved.pending) {
        if (!same(saved.previousClaim, continuation.previousClaim)) refuse("Prompt reservation continuation was replaced");
        return { writes: [], continuation: saved };
      }
    }
    if (current === null || !same(current.toJSON(), this.snapshot.toJSON())) refuse("Prompt reservation frontier changed before reconciliation");
    const next = JSON.parse(JSON.stringify(current.toJSON()));
    next.batches.find((entry) => entry.claim !== null).reservationContinuation = continuation.toJSON();
    const snapshot = PromptExecutionJournalSnapshot.fromJSON(next);
    const publication = new PromptExecutionProgressPublication({ contract: this.contract, scope: this.scope,
      record: new PromptExecutionJournalRecord({ event: "reservation-reconciled", snapshot }),
      expectedSnapshotDigest: executionValueDigest(current.toJSON()), operationId: this.operationId,
      expectedCheckoutIdentity: this.physicalEvidence.checkoutIdentity, reservationAdmission: this });
    return { ...publication.prepare(view), continuation };
  }
  assert(view) { this.prepare(view); }
  readAcknowledgement(view) {
    const saved = read(view, "prompt.execution.event", { ...scopeParameters(this.contract, this.scope), eventId: this.operationId });
    if (saved === null) return false;
    assertProducer(saved, this.contract);
    if (saved.document.contractId !== this.contract.id || saved.document.record.event !== "reservation-reconciled"
      || saved.document.digest !== executionValueDigest(saved.document.record)) refuse("Prompt reservation acknowledgement belongs to another event");
    const snapshot = PromptExecutionJournalSnapshot.fromJSON(saved.document.record.snapshot);
    const batch = snapshot.batches.find((entry) => entry.reservationContinuation?.authorizationId === this.authorizationId);
    if (batch === undefined || !same(batch.claim, this.snapshot.batches.find((entry) => entry.claim !== null).claim)) {
      refuse("Prompt reservation acknowledgement differs from its claimed reservation");
    }
    return true;
  }
}
/** State deltas are checked at the persistence boundary, before durable call admission. */
function assertTransition(previous, record, currentBudget) {
  const next = record.snapshot.toJSON();
  if (record.event === "planned") {
    const expected = { ...currentBudget, synthesisCallCount: currentBudget.synthesisCallCount + (next.plan.synthesisCallCount ?? 0) };
    if (previous !== null || !same(next.budget, expected)
      || next.batches.some((entry) => entry.batchCalls !== 0 || entry.claim !== null || entry.responses.length || entry.transportFailures.length
        || entry.processStops?.length || entry.reservationContinuation !== undefined || entry.completion !== null)) refuse("Prompt plan does not begin at the durable budget frontier");
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
  if (!["reservation-reconciled", "reservation-consumed"].includes(record.event)
    && !same(batch.reservationContinuation, old.reservationContinuation)) refuse("Prompt event changed its immutable reservation continuation");
  if (record.event !== "process-stopped" && !same(batch.processStops ?? [], old.processStops ?? [])) refuse("Prompt event altered its immutable stop observations");
  if (record.event === "reservation-reconciled") {
    const { reservationContinuation, ...frontier } = batch;
    const { reservationContinuation: previousReservation, ...oldFrontier } = old;
    if (old.claim === null || !same(frontier, oldFrontier)
      || !same(next.budget, currentBudget) || !same(next.groups, previous.groups)) refuse("Prompt reconciliation changed its claim or consumed budget");
    const continuation = PromptExecutionReservationContinuation.fromJSON(reservationContinuation);
    if (!continuation.pending || !same(continuation.previousClaim, old.claim)) refuse("Prompt reconciliation does not bind its unresolved claim");
    if (previousReservation === undefined) {
      if (continuation.history.length !== 0) refuse("Initial Prompt reconciliation invented an earlier reservation lineage");
    } else {
      const previousContinuation = PromptExecutionReservationContinuation.fromJSON(previousReservation);
      if (previousContinuation.pending || !same(previousContinuation.reconcile({ physicalEvidence: continuation.physicalEvidence,
        calls: continuation.calls }).toJSON(), continuation.toJSON())) refuse("Prompt reconciliation removed or changed its prior reservation lineage");
    }
  } else if (record.event === "reservation-consumed") {
    const previousContinuation = PromptExecutionReservationContinuation.fromJSON(old.reservationContinuation);
    const continuation = PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
    const { claim: oldClaim, reservationContinuation: oldReservation, ...oldFrontier } = old;
    const { claim, reservationContinuation: replacementReservation, ...nextFrontier } = batch;
    if (!previousContinuation.pending || continuation.pending || !same(previousContinuation.consume(claim).toJSON(), continuation.toJSON())
      || !same(oldFrontier, nextFrontier) || !same(next.budget, currentBudget)
      || !same(next.groups, previous.groups)) refuse("Prompt reservation was consumed twice or changed its budget");
  } else if (record.event === "claimed") {
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
  constructor({ contract, scope, record, expectedSnapshotDigest, operationId, expectedCheckoutIdentity = null, reservationAdmission = null }) {
    if (!(contract instanceof FlowExecutionContract) || !(scope instanceof PromptExecutionScope)
      || !(record instanceof PromptExecutionJournalRecord) || !same(scope.toJSON(), record.scope.toJSON())) throw new TypeError("Prompt persistence requires typed execution inputs");
    Object.assign(this, { contract, scope, record, expectedSnapshotDigest, operationId, expectedCheckoutIdentity, reservationAdmission });
    Object.freeze(this);
  }
  prepare(view) {
    if (this.record.event === "reservation-reconciled") {
      if (!(this.reservationAdmission instanceof CanonicalPromptReservationReconciliationPublication)) refuse("Prompt reconciliation requires its held physical admission");
      const continuation = this.reservationAdmission.assertEvidence(view);
      const saved = this.record.snapshot.batches.find((batch) => batch.reservationContinuation !== undefined)?.reservationContinuation;
      if (!same(saved, continuation.toJSON())) refuse("Prompt reconciliation differs from its authenticated physical observation");
    }
    readExecutionContractFromView(view, this.contract);
    const parameters = scopeParameters(this.contract, this.scope);
    const previous = readScopeProgress(view, this.contract, this.scope);
    const snapshot = previous === null ? null : assertProgressDocument(previous, this.contract, this.scope, this.expectedCheckoutIdentity).toJSON();
    if ((snapshot === null ? null : executionValueDigest(snapshot)) !== this.expectedSnapshotDigest) refuse("Prompt execution scope frontier changed before save");
    const budget = readEpisodeBudget(view, this.contract);
    assertPromptStopContract(this.record.snapshot, this.contract, this.expectedCheckoutIdentity);
    for (const batch of this.record.snapshot.batches) for (const response of batch.responses) {
      if (response.executionObservation === undefined) continue;
      assertPromptReceiverContract(PromptResponseExecutionObservation.fromJSON(response.executionObservation), this.contract, view.state.flowVersionId);
    }
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
