import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { ProcessExecutionStopReceipt, ProcessExecutionControlFailure, ProcessExecutionRecoveryCall,
  ProcessExecutionNonExecutionEvidence, executionValueDigest as processEvidenceDigest } from "./process-execution-values.js";
import { AgentTransportFailureObservation } from "./agent-transport-failure-observation.js";

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be non-empty text`);
  return value;
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function freeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freeze(entry)])));
}

function fields(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expected.sort().join(",")) {
    throw new TypeError(`${name} has invalid serialized fields`);
  }
}

export class PromptExecutionJournalError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
  }
}

const persistenceFailures = new WeakSet();

export function preservePromptExecutionControlFailure(error) {
  if (error !== null && typeof error === "object") persistenceFailures.add(error);
  return error;
}

export function isPromptExecutionControlFailure(error) {
  return error instanceof PromptExecutionJournalError || error instanceof ProcessExecutionControlFailure || (error !== null && typeof error === "object" && persistenceFailures.has(error));
}

/** Optional durable observer used by the existing cache-aware admission. */
export class PromptProviderAttemptJournal {
  constructor(initialAttemptCount = 0) {
    this.initialAttemptCount = integer(initialAttemptCount, "Prompt restored transport attempt count");
  }

  async beforeProviderAttempt() { throw new Error(`${this.constructor.name}.beforeProviderAttempt() is not implemented`); }
  async observeProcessStop() { throw new Error(`${this.constructor.name}.observeProcessStop() is not implemented`); }
  async afterProviderFailure() { throw new Error(`${this.constructor.name}.afterProviderFailure() is not implemented`); }
  recordCacheHit() { throw new Error(`${this.constructor.name}.recordCacheHit() is not implemented`); }
}

export class PromptExecutionProviderIdentity {
  constructor({ providerKey, profileKey }) {
    this.providerKey = text(providerKey, "Prompt provider identity");
    this.profileKey = text(profileKey, "Prompt profile identity");
    Object.freeze(this);
  }
  toJSON() { return { providerKey: this.providerKey, profileKey: this.profileKey }; }
}

export class PromptExecutionScope {
  constructor({ stage, round = 0 } = {}) {
    this.stage = text(stage, "Prompt execution stage");
    this.round = integer(round, "Prompt execution round");
    Object.freeze(this);
  }

  toJSON() { return { stage: this.stage, round: this.round }; }

  static fromJSON(value) {
    fields(value, ["stage", "round"], "Prompt execution scope");
    return new PromptExecutionScope(value);
  }
}

/** Exact physical Prompt transport identity, independent from retry policy. */
export class PromptProviderProcessIdentity {
  constructor({ scope, batchDigest, responseCallIndex, transportOrdinal, attempt, maxAttempts,
    requestDigest, schemaDigest, providerKey, profileKey, logicalInvocationId, providerAttemptId }) {
    this.scope = scope instanceof PromptExecutionScope ? scope : PromptExecutionScope.fromJSON(scope);
    for (const [key, value] of Object.entries({ batchDigest, requestDigest, schemaDigest, providerKey,
      profileKey, logicalInvocationId, providerAttemptId })) this[key] = text(value, key);
    for (const [key, value] of Object.entries({ responseCallIndex, transportOrdinal, attempt, maxAttempts })) this[key] = integer(value, key);
    if (transportOrdinal < 1 || attempt < 1 || maxAttempts < attempt) throw new TypeError("Prompt physical attempt ordinal is invalid");
    Object.freeze(this);
  }
  toJSON() { return { scope: this.scope.toJSON(), batchDigest: this.batchDigest, responseCallIndex: this.responseCallIndex,
    transportOrdinal: this.transportOrdinal, attempt: this.attempt, maxAttempts: this.maxAttempts,
    requestDigest: this.requestDigest, schemaDigest: this.schemaDigest, providerKey: this.providerKey,
    profileKey: this.profileKey, logicalInvocationId: this.logicalInvocationId, providerAttemptId: this.providerAttemptId }; }
  static fromJSON(value) {
    const restored = new this(value);
    if (!isDeepStrictEqual(restored.toJSON(), value)) throw new TypeError("Prompt physical identity has unknown or inconsistent fields");
    return restored;
  }
  assertClaim(claim) {
    if (!claim || !isDeepStrictEqual(claim.processIdentity, this.toJSON())
      || ["responseCallIndex", "transportOrdinal", "attempt", "maxAttempts", "requestDigest", "schemaDigest", "providerKey", "profileKey"]
        .some((key) => claim[key] !== this[key])) throw new PromptExecutionJournalError("PROMPT_EXECUTION_IDENTITY_MISMATCH", "Stop observation does not match the saved Prompt claim");
  }
}

/** Durable OS observation; never a response, failure, or claim settlement. */
export class PromptProcessStopObservation {
  constructor({ identity, receipt }) {
    this.identity = identity instanceof PromptProviderProcessIdentity ? identity : PromptProviderProcessIdentity.fromJSON(identity);
    this.receipt = receipt instanceof ProcessExecutionStopReceipt ? receipt : new ProcessExecutionStopReceipt(receipt);
    const invocation = this.receipt.invocation;
    const context = invocation?.providerAttemptContext;
    const binding = this.receipt.binding.toJSON();
    if (this.receipt.launcherIdentity === null || this.receipt.pgid === null
      || !isDeepStrictEqual(invocation?.promptProcessIdentity, this.identity.toJSON())
      || invocation.providerAttemptId !== this.identity.providerAttemptId || invocation.logicalInvocationId !== this.identity.logicalInvocationId
      || context?.attemptId !== this.identity.providerAttemptId || context?.logicalInvocationId !== this.identity.logicalInvocationId
      || context?.attempt !== this.identity.attempt || context?.maxAttempts !== this.identity.maxAttempts
      || context?.providerKey !== this.identity.providerKey || context?.profileKey !== this.identity.profileKey
      || !binding || ["runId", "specId", "nodeId", "attemptId", "executionContractId"].some((key) => typeof binding[key] !== "string" || !binding[key])
      || !Number.isSafeInteger(binding.attemptSequence) || binding.attemptSequence < 1
      || !Number.isSafeInteger(binding.executionGeneration) || binding.executionGeneration < 0) {
      throw new PromptExecutionJournalError("PROMPT_EXECUTION_IDENTITY_MISMATCH", "Managed stop receipt differs from the Prompt physical or semantic binding");
    }
    Object.freeze(this);
  }
  toJSON() { return { identity: this.identity.toJSON(), receipt: JSON.parse(JSON.stringify(this.receipt)) }; }
  static fromJSON(value) {
    const restored = new this(value);
    if (!isDeepStrictEqual(restored.toJSON(), value)) throw new TypeError("Prompt stop observation has unknown or inconsistent fields");
    return restored;
  }
}

/** Durable proof that one existing provider reservation has never received start permission. */
export class PromptExecutionReservationContinuation {
  constructor({ authorizationId, executionContractId, previousClaim, physicalEvidence, calls, consumedClaim = null, history = [] }) {
    this.authorizationId = text(authorizationId, "Prompt reservation authorization");
    this.executionContractId = text(executionContractId, "Prompt reservation execution contract");
    const identity = PromptProviderProcessIdentity.fromJSON(previousClaim.processIdentity);
    identity.assertClaim(previousClaim);
    const { id, digest, ...summary } = physicalEvidence;
    if (id !== digest || digest !== processEvidenceDigest(summary)
      || summary.binding?.executionContractId !== executionContractId) throw new TypeError("Prompt reservation proof differs from its canonical execution");
    const restored = calls.map((call) => new ProcessExecutionRecoveryCall(call));
    if (!isDeepStrictEqual(restored.map((call) => call.toJSON()), summary.calls)
      || !isDeepStrictEqual(summary.invocation, { providerAttemptId: identity.providerAttemptId, logicalInvocationId: identity.logicalInvocationId })
      || restored.some((call) => call.startPermitted || call.invocation?.providerAttemptId !== identity.providerAttemptId
        || call.invocation?.logicalInvocationId !== identity.logicalInvocationId)) {
      throw new TypeError("Prompt reservation proof does not demonstrate an unstarted provider invocation");
    }
    if (restored.length === 0) {
      if (summary.nonExecution === null) throw new TypeError("Prompt reservation has no non-execution proof");
      const absence = ProcessExecutionNonExecutionEvidence.fromStored(summary.nonExecution);
      if (!isDeepStrictEqual(absence.invocation.toJSON(), summary.invocation)
        || !isDeepStrictEqual(absence.binding.toJSON(), summary.binding)
        || !isDeepStrictEqual(absence.checkoutIdentity.toJSON(), summary.checkoutIdentity)
        || absence.inventoryDigest !== summary.inventoryDigest || absence.ownerEpoch !== summary.ownerEpoch) {
        throw new TypeError("Prompt reservation non-execution proof differs from its inventory");
      }
    } else if (summary.nonExecution !== null) throw new TypeError("Prompt reservation has contradictory physical evidence");
    if (consumedClaim !== null) {
      const replacement = PromptProviderProcessIdentity.fromJSON(consumedClaim.processIdentity);
      replacement.assertClaim(consumedClaim);
      if (["responseCallIndex", "transportOrdinal", "attempt", "maxAttempts", "requestDigest", "schemaDigest", "providerKey", "profileKey"]
        .some((key) => previousClaim[key] !== consumedClaim[key])
        || replacement.providerAttemptId === identity.providerAttemptId) throw new TypeError("Prompt reservation continuation changed its reserved call or reused its physical attempt");
    }
    if (!Array.isArray(history)) throw new TypeError("Prompt reservation history must be an ordered claim lineage");
    const previous = history.map((entry) => {
      fields(entry, ["previousClaim", "physicalEvidence", "calls", "consumedClaim"], "Prompt reservation history entry");
      return new PromptExecutionReservationContinuation({ authorizationId, executionContractId, ...entry });
    });
    for (const [index, entry] of previous.entries()) {
      if (entry.pending || entry.history.length !== 0 || !isDeepStrictEqual(entry.consumedClaim,
        previous[index + 1]?.previousClaim ?? previousClaim)) throw new TypeError("Prompt reservation history is not a contiguous unused-claim lineage");
    }
    this.previousClaim = freeze(previousClaim);
    this.physicalEvidence = freeze(physicalEvidence);
    this.calls = freeze(calls);
    this.consumedClaim = consumedClaim === null ? null : freeze(consumedClaim);
    this.history = freeze(history);
    Object.freeze(this);
  }
  get pending() { return this.consumedClaim === null; }
  get id() {
    const { consumedClaim, ...identity } = this.toJSON();
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }
  consume(claim) {
    if (!this.pending) throw new PromptExecutionJournalError("PROMPT_EXECUTION_UNCERTAIN", "Prompt reservation continuation is already consumed");
    return new PromptExecutionReservationContinuation({ ...this.toJSON(), consumedClaim: claim });
  }
  reconcile({ physicalEvidence, calls }) {
    if (this.pending) throw new PromptExecutionJournalError("PROMPT_EXECUTION_UNCERTAIN", "Prompt reservation already has an unused continuation");
    const { authorizationId, executionContractId, history, ...previous } = this.toJSON();
    return new PromptExecutionReservationContinuation({ authorizationId, executionContractId,
      previousClaim: this.consumedClaim, physicalEvidence, calls, history: [...history, previous] });
  }
  toJSON() { return { authorizationId: this.authorizationId, executionContractId: this.executionContractId,
    previousClaim: this.previousClaim, physicalEvidence: this.physicalEvidence, calls: this.calls,
    consumedClaim: this.consumedClaim, history: this.history }; }
  static fromJSON(value) {
    const restored = new this(value);
    if (!isDeepStrictEqual(restored.toJSON(), value)) throw new TypeError("Prompt reservation continuation has unknown fields");
    return restored;
  }
}

/** Immutable identity of the entire plan, including ordered input coverage. */
export class PromptExecutionPlanIdentity {
  constructor(value) {
    fields(value, ["digest", "collectionDigest", "batches", "synthesisCallCount"], "Prompt execution plan identity");
    integer(value.synthesisCallCount, "Prompt execution synthesis reservation");
    text(value.digest, "Prompt execution plan digest");
    text(value.collectionDigest, "Prompt execution collection digest");
    if (!Array.isArray(value.batches) || value.batches.length === 0) throw new TypeError("Prompt execution identity requires batches");
    for (const [index, batch] of value.batches.entries()) {
      fields(batch, ["digest", "groupId", "index", "coverage"], "Prompt execution batch identity");
      text(batch.digest, "Prompt execution batch digest");
      text(batch.groupId, "Prompt execution group ID");
      if (batch.index !== index || !Array.isArray(batch.coverage)) throw new TypeError("Prompt execution batch identity is invalid");
    }
    if (new Set(value.batches.map((batch) => batch.digest)).size !== value.batches.length) throw new TypeError("Prompt execution batch identity is duplicated");
    Object.assign(this, freeze(value));
    Object.freeze(this);
  }

  static fromPlan(plan, synthesisCallCount = 0) {
    return new PromptExecutionPlanIdentity({ digest: plan.digest, collectionDigest: plan.collection.digest, synthesisCallCount,
      batches: plan.batches.map((batch) => ({ digest: batch.digest, groupId: batch.groupId, index: batch.index,
        coverage: batch.coverage.map((entry) => entry.toJSON()) })) });
  }

  toJSON() { return { digest: this.digest, collectionDigest: this.collectionDigest, batches: this.batches, synthesisCallCount: this.synthesisCallCount }; }

  assertPlan(plan, synthesisCallCount = 0) {
    if (JSON.stringify(this.toJSON()) !== JSON.stringify(PromptExecutionPlanIdentity.fromPlan(plan, synthesisCallCount).toJSON())) {
      throw new PromptExecutionJournalError("PROMPT_EXECUTION_IDENTITY_MISMATCH", "Saved prompt execution belongs to a different plan");
    }
  }
}

/** Serialized frontier supplied by the authoritative reader before execution. */
export class PromptExecutionJournalSnapshot {
  constructor({ scope, plan, budget, groups, batches }) {
    if (!(scope instanceof PromptExecutionScope) || !(plan instanceof PromptExecutionPlanIdentity)) {
      throw new TypeError("Prompt execution snapshot requires typed scope and plan identity");
    }
    fields(budget, ["providerCallCount", "synthesisCallCount", "aggregateCharacters", "aggregateItemCount"], "Prompt execution budget");
    Object.entries(budget).forEach(([key, value]) => integer(value, key));
    if (!Array.isArray(groups) || !Array.isArray(batches) || batches.length !== plan.batches.length) throw new TypeError("Prompt execution frontier is incomplete");
    const groupIds = new Set(plan.batches.map((batch) => batch.groupId));
    if (groups.length !== groupIds.size || new Set(groups.map((group) => group.groupId)).size !== groups.length) throw new TypeError("Prompt execution groups are invalid");
    for (const group of groups) {
      fields(group, ["groupId", "budget", "responseCallCount"], "Prompt execution group frontier");
      if (!groupIds.has(group.groupId)) throw new TypeError("Prompt execution group is foreign");
      fields(group.budget, Object.keys(budget), "Prompt execution group budget");
      Object.entries(group.budget).forEach(([key, value]) => integer(value, key));
      integer(group.responseCallCount, "Prompt group response call count");
    }
    for (const [index, batch] of batches.entries()) {
      fields(batch, ["batchDigest", "batchCalls", "transportOrdinal", "claim", "responses", "transportFailures", "completion",
        ...(Object.hasOwn(batch, "processStops") ? ["processStops"] : []),
        ...(Object.hasOwn(batch, "reservationContinuation") ? ["reservationContinuation"] : [])], "Prompt execution batch frontier");
      if (batch.batchDigest !== plan.batches[index].digest) throw new TypeError("Prompt execution frontier order or digest is invalid");
      integer(batch.batchCalls, "Prompt batch calls");
      integer(batch.transportOrdinal, "Prompt transport ordinal");
      if (!Array.isArray(batch.responses) || !Array.isArray(batch.transportFailures)) throw new TypeError("Prompt execution observations are invalid");
      const responseIds = new Set();
      const group = groups.find((entry) => entry.groupId === plan.batches[index].groupId);
      for (const [responseIndex, response] of batch.responses.entries()) {
        fields(response, ["responseCallIndex", "requestDigest", "schemaDigest", "providerKey", "profileKey", "raw", "origin", "executionAccounting", "responseCharacters", "responseDigest", "rejection"], "Prompt response observation");
        integer(response.responseCallIndex, "Prompt response call index");
        text(response.requestDigest, "Prompt response request digest");
        for (const key of ["schemaDigest", "providerKey", "profileKey"]) text(response[key], `Prompt response ${key}`);
        if (typeof response.responseDigest !== "string" || !/^[a-f0-9]{64}$/.test(response.responseDigest)) throw new TypeError("Prompt response content digest is invalid");
        integer(response.responseCharacters, "Prompt response characters");
        fields(response.executionAccounting, ["responseCallCount", "providerAttemptCount"], "Prompt response accounting");
        Object.entries(response.executionAccounting).forEach(([key, value]) => integer(value, key));
        if (response.raw === undefined || !["provider", "cache"].includes(response.origin)
          || ![null, "PROMPT_RESPONSE_TOO_LARGE"].includes(response.rejection)
          || (response.rejection !== null && response.raw !== null)
          || response.responseCallIndex !== responseIndex || response.responseCallIndex >= batch.batchCalls
          || responseIds.has(response.responseCallIndex)
          || response.executionAccounting.responseCallCount > group.responseCallCount
          || response.executionAccounting.providerAttemptCount > group.budget.providerCallCount) throw new TypeError("Prompt response observation is invalid");
        responseIds.add(response.responseCallIndex);
      }
      const failedCalls = new Map();
      for (const failure of batch.transportFailures) {
        fields(failure, ["responseCallIndex", "attempt", "maxAttempts", "code", "retryable", "requestDigest", "schemaDigest", "providerKey", "profileKey", "observation"], "Prompt transport failure");
        AgentTransportFailureObservation.fromJSON(failure.observation).assertFailure(failure);
        integer(failure.responseCallIndex, "Prompt failed response index");
        integer(failure.attempt, "Prompt failed attempt");
        integer(failure.maxAttempts, "Prompt failed attempt limit");
        text(failure.code, "Prompt transport failure code");
        for (const key of ["requestDigest", "schemaDigest", "providerKey", "profileKey"]) text(failure[key], `Prompt failed transport ${key}`);
        if (failure.attempt < 1 || failure.attempt > failure.maxAttempts || typeof failure.retryable !== "boolean"
          || failure.responseCallIndex >= batch.batchCalls
          || failure.attempt !== (failedCalls.get(failure.responseCallIndex) ?? 0) + 1) throw new TypeError("Prompt transport failure is invalid");
        failedCalls.set(failure.responseCallIndex, failure.attempt);
      }
      if (batch.claim !== null) {
        fields(batch.claim, ["responseCallIndex", "transportOrdinal", "attempt", "maxAttempts", "requestDigest", "schemaDigest", "providerKey", "profileKey", ...(Object.hasOwn(batch.claim, "processIdentity") ? ["processIdentity"] : [])], "Prompt transport claim");
        for (const key of ["responseCallIndex", "transportOrdinal", "attempt", "maxAttempts"]) integer(batch.claim[key], key);
        for (const key of ["requestDigest", "schemaDigest", "providerKey", "profileKey"]) text(batch.claim[key], `Prompt transport claim ${key}`);
        if (batch.claim.transportOrdinal !== batch.transportOrdinal || batch.claim.attempt < 1
          || batch.claim.attempt > batch.claim.maxAttempts || batch.claim.responseCallIndex >= batch.batchCalls
          || batch.claim.responseCallIndex !== batch.batchCalls - 1
          || batch.claim.attempt !== (failedCalls.get(batch.claim.responseCallIndex) ?? 0) + 1
          || responseIds.has(batch.claim.responseCallIndex)) throw new TypeError("Prompt transport claim is invalid");
      }
      if (batch.claim?.processIdentity) {
        const identity = PromptProviderProcessIdentity.fromJSON(batch.claim.processIdentity);
        identity.assertClaim(batch.claim);
        if (identity.batchDigest !== batch.batchDigest || !isDeepStrictEqual(identity.scope.toJSON(), scope.toJSON())) throw new TypeError("Prompt physical claim belongs to another batch or scope");
      }
      if (batch.reservationContinuation !== undefined) {
        const continuation = PromptExecutionReservationContinuation.fromJSON(batch.reservationContinuation);
        const identity = PromptProviderProcessIdentity.fromJSON(continuation.previousClaim.processIdentity);
        if (identity.batchDigest !== batch.batchDigest || !isDeepStrictEqual(identity.scope.toJSON(), scope.toJSON())
          || identity.transportOrdinal > batch.transportOrdinal || identity.responseCallIndex >= batch.batchCalls
          || batch.claim !== null && (continuation.pending || batch.claim.transportOrdinal === continuation.consumedClaim.transportOrdinal)
            && !isDeepStrictEqual(batch.claim, continuation.pending ? continuation.previousClaim : continuation.consumedClaim)
          || continuation.pending && batch.claim === null) throw new TypeError("Prompt reservation continuation differs from its batch claim");
      }
      if (Object.hasOwn(batch, "processStops")) {
        if (!Array.isArray(batch.processStops) || batch.processStops.length === 0) throw new TypeError("Prompt stop observations are invalid");
        const stoppedCalls = new Set();
        for (const value of batch.processStops) {
          const observation = PromptProcessStopObservation.fromJSON(value);
          const identity = observation.identity;
          if (identity.batchDigest !== batch.batchDigest || !isDeepStrictEqual(identity.scope.toJSON(), scope.toJSON())
            || identity.transportOrdinal > batch.transportOrdinal || identity.responseCallIndex >= batch.batchCalls
            || stoppedCalls.has(identity.transportOrdinal)) throw new TypeError("Prompt stop observation lineage is invalid");
          stoppedCalls.add(identity.transportOrdinal);
          if (batch.claim?.transportOrdinal === identity.transportOrdinal) identity.assertClaim(batch.claim);
        }
      }
      const activeCall = batch.claim !== null || failedCalls.has(batch.responses.length);
      if (batch.batchCalls !== batch.responses.length + (activeCall ? 1 : 0)
        || batch.transportOrdinal !== batch.transportFailures.length + batch.responses.filter((response) => response.origin === "provider").length + (batch.claim ? 1 : 0)) {
        throw new TypeError("Prompt execution protocol or transport frontier is inconsistent");
      }
      if (batch.completion !== null) {
        fields(batch.completion, ["response", "responseCharacters", "responseItemCount", "executionAccounting"], "Prompt validated completion");
        integer(batch.completion.responseCharacters, "Prompt completion characters");
        integer(batch.completion.responseItemCount, "Prompt completion items");
        fields(batch.completion.executionAccounting, ["responseCallCount", "providerAttemptCount"], "Prompt completion accounting");
        Object.entries(batch.completion.executionAccounting).forEach(([key, value]) => integer(value, key));
        if (batch.completion.response === undefined || batch.claim !== null || activeCall
          || batch.completion.executionAccounting.responseCallCount > group.responseCallCount
          || batch.completion.executionAccounting.providerAttemptCount > group.budget.providerCallCount) throw new TypeError("Prompt completion is invalid");
      }
    }
    if (groups.reduce((sum, group) => sum + group.budget.providerCallCount, 0) > budget.providerCallCount) throw new TypeError("Prompt group budgets exceed the shared execution frontier");
    this.scope = scope;
    this.plan = plan;
    this.budget = freeze(budget);
    this.groups = freeze(groups);
    this.batches = freeze(batches);
    Object.freeze(this);
  }

  toJSON() { return { scope: this.scope.toJSON(), plan: this.plan.toJSON(), budget: this.budget, groups: this.groups, batches: this.batches }; }

  static fromJSON(value) {
    fields(value, ["scope", "plan", "budget", "groups", "batches"], "Prompt execution snapshot");
    return new PromptExecutionJournalSnapshot({ ...value, scope: PromptExecutionScope.fromJSON(value.scope), plan: new PromptExecutionPlanIdentity(value.plan) });
  }
}

export class PromptExecutionJournalRecord {
  constructor({ event, snapshot }) {
    if (!["planned", "claimed", "reservation-reconciled", "reservation-consumed", "process-stopped", "transport-failed", "response", "validated"].includes(event)
      || !(snapshot instanceof PromptExecutionJournalSnapshot)) throw new TypeError("Prompt execution record is invalid");
    this.event = event;
    this.scope = snapshot.scope;
    this.snapshot = snapshot;
    Object.freeze(this);
  }

  toJSON() { return { scope: this.scope.toJSON(), event: this.event, snapshot: this.snapshot.toJSON() }; }
}

/** Save-only port. The Store owns admission, atomic persistence and ACK readback. */
export class PromptExecutionJournalWriter {
  async save() { throw new Error(`${this.constructor.name}.save() is not implemented`); }
}

export class PromptExecutionJournal {
  #snapshot;

  constructor({ scope, writer, snapshot = null } = {}) {
    if (!(scope instanceof PromptExecutionScope) || !(writer instanceof PromptExecutionJournalWriter)
      || (snapshot !== null && !(snapshot instanceof PromptExecutionJournalSnapshot))) {
      throw new TypeError("Prompt execution journal requires typed scope, writer and snapshot");
    }
    if (snapshot && JSON.stringify(scope.toJSON()) !== JSON.stringify(snapshot.scope.toJSON())) {
      throw new PromptExecutionJournalError("PROMPT_EXECUTION_IDENTITY_MISMATCH", "Saved prompt execution belongs to a different stage or round");
    }
    this.scope = scope;
    this.writer = writer;
    this.#snapshot = snapshot;
    Object.freeze(this);
  }

  get snapshot() { return this.#snapshot; }

  assertResumable(plan, synthesisCallCount = 0, reservationContinuation = null) {
    this.#snapshot?.plan.assertPlan(plan, synthesisCallCount);
    const unresolved = this.#snapshot?.batches.filter((batch) => batch.claim !== null) ?? [];
    if (unresolved.length > 0 && !(reservationContinuation instanceof PromptExecutionReservationContinuation
      && reservationContinuation.pending && unresolved.length === 1
      && isDeepStrictEqual(unresolved[0].reservationContinuation, reservationContinuation.toJSON()))) {
      throw new PromptExecutionJournalError("PROMPT_EXECUTION_UNCERTAIN", "Saved provider claim has no durable response or failure observation");
    }
  }

  async save(event, snapshot) {
    if (!(snapshot instanceof PromptExecutionJournalSnapshot)
      || JSON.stringify(snapshot.scope.toJSON()) !== JSON.stringify(this.scope.toJSON())) throw new TypeError("Prompt journal checkpoint scope is invalid");
    const record = new PromptExecutionJournalRecord({ event, snapshot });
    try { await this.writer.save(record); }
    catch (cause) {
      if (cause !== null && typeof cause === "object") throw preservePromptExecutionControlFailure(cause);
      throw new PromptExecutionJournalError("PROMPT_EXECUTION_PERSISTENCE_FAILED", "Prompt execution checkpoint could not be saved", cause);
    }
    this.#snapshot = snapshot;
  }
}
