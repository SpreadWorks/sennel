import { ProcessExecutionRuntime } from "../lib/process-execution-runtime.js";
import { validateSchema } from "../lib/schema-validate.js";
import { captureExecutionObservations, executionProducerCoverage } from "../lib/flow-execution-observation.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../lib/flow-artifact-contract.js";
import { capturePromptExecutionReceiversFromView, readExecutionContractFromView } from "./lib/canonical-prompt-execution.js";
import { FlowExecutionContract } from "./lib/flow-execution-contract.js";
import { capturePromptResponseAdoptionsFromView } from "./lib/prompt-response-adoption-publication.js";
import { CurrentFlowOutboxAttemptHistory } from "./lib/flow-outbox-attempt-history.js";
import { CurrentFlowAttemptHistory } from "./lib/current-flow-state.js";
import { FLOW_QUERY_ERROR_CODES, FLOW_QUERY_LIMITS, FLOW_QUERY_RESPONSE_SCHEMA, isFlowQueryDatetime, validateFlowQueryRequest } from "./query-contract.js";
import { QueryError, canonicalDigest, canonicalJson, boundedPublic, publicArtifactId } from "./query-values.js";

const ITEM_KINDS = Object.freeze(["step-attempt", "agent-invocation", "provider-attempt", "process-call", "outbox-attempt"]);
const REFERENCE_KINDS = new Set([...ITEM_KINDS, "activity", "artifact", "prompt-response", "step-settlement", "diagnostic-request"]);
const BINDING_FIELDS = Object.freeze(["flowVersionId", "runId", "specId", "nodeId", "taskId", "stepAttemptId", "stepAttemptSequence", "executionContractId", "executionGeneration"]);
const MEASUREMENT_FIELDS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd"]);
const byteOrder = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const serialize = (value) => value?.toJSON ? value.toJSON() : value;
const digest = (value) => canonicalDigest(value, { maxBytes: FLOW_QUERY_LIMITS.MAX_TOTAL_ARTIFACT_BYTES });
const itemSchemas = new Map(FLOW_QUERY_RESPONSE_SCHEMA.oneOf.find((variant) => variant.properties.resource?.enum[0] === "executions" && variant.properties.ok.enum[0] === true)
  .properties.items.items.oneOf.map((schema) => [schema.properties.kind.enum[0], schema]));

export class QueryExecutionTarget {
  constructor({ nodeId, includeDescendants, attemptId }) {
    if (typeof nodeId !== "string" || !nodeId || typeof includeDescendants !== "boolean" || attemptId !== null && (typeof attemptId !== "string" || !attemptId)) throw new TypeError("Execution target requires a node, descendant selection and nullable Attempt identity");
    Object.assign(this, { nodeId, includeDescendants, attemptId });
    Object.freeze(this);
  }
  toJSON() { return { nodeId: this.nodeId, includeDescendants: this.includeDescendants, attemptId: this.attemptId }; }
}

const factString = Object.freeze({ type: "string", minLength: 1 });
const nullableFactString = Object.freeze({ type: ["string", "null"] });
const factNumber = Object.freeze({ type: "number", minimum: 0 });
const factInteger = Object.freeze({ type: "integer", minimum: 0 });
const factObject = (properties) => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
const reportedIdentity = factObject({ model: nullableFactString, effort: nullableFactString });
const requestedIdentity = factObject({ provider: factString, profileKey: factString, model: nullableFactString, effort: nullableFactString });
const failureEvidence = { ...factObject({ code: nullableFactString, reason: nullableFactString }), type: ["object", "null"] };
const observationSchemas = Object.freeze({
  "agent-started": factObject({ logicalInvocationId: factString, requestId: factString,
    caller: { type: ["object", "null"], required: ["kind", "id", "flowVersionId"], properties: { kind: { type: "string", enum: ["step-attempt", "agent-invocation"] }, id: factString, flowVersionId: factString }, additionalProperties: false },
    role: nullableFactString, commandId: nullableFactString, requested: requestedIdentity,
    responseMode: { type: "string", enum: ["return-to-caller"] }, promptIdentity: { type: ["object", "null"] } }),
  "agent-response-ready": factObject({ logicalInvocationId: factString, requestId: factString, cacheOutcome: factString,
    responseCharacters: factInteger, reported: reportedIdentity, durationMs: factNumber,
    measurementScope: { type: "string", enum: ["final-logical-response"] }, measurementId: factString }),
  "agent-failed": factObject({ logicalInvocationId: factString, requestId: factString, code: nullableFactString,
    failure: failureEvidence, durationMs: factNumber }),
  "provider-started": factObject({ logicalInvocationId: factString, providerAttemptId: factString, measurementId: factString,
    attemptIndex: factInteger, maxAttempts: { type: "integer", minimum: 1 }, provider: factString, profileKey: factString,
    providerStarted: { type: "null" }, requested: requestedIdentity }),
  "provider-settled": factObject({ logicalInvocationId: factString, providerAttemptId: factString, measurementId: factString,
    providerStarted: { type: ["boolean", "null"] }, status: { type: "string", enum: ["completed", "empty", "failed"] },
    usage: { type: ["object", "null"] }, reported: reportedIdentity, startedAt: nullableFactString, endedAt: nullableFactString,
    durationMs: { type: ["number", "null"], minimum: 0 }, attemptIndex: factInteger, maxAttempts: { type: "integer", minimum: 1 },
    failure: failureEvidence, measurementScope: { type: "string", enum: ["provider-attempt"] } }),
});

function inconsistent(message, cause = null) {
  throw new QueryError(FLOW_QUERY_ERROR_CODES.EXECUTION_RECORD_INCONSISTENT, "/canonical", message, { cause });
}

/** Public identities never depend on a snapshot, current cursor, or wall clock. */
export class ExecutionReference {
  constructor(kind, id) {
    if (!REFERENCE_KINDS.has(kind) || typeof id !== "string" || id.length === 0) throw new TypeError("Execution reference requires a known kind and identity");
    this.kind = kind;
    this.id = id;
    Object.freeze(this);
  }
  static for(version, kind, identity) { return new this(kind, `${kind}:${digest({ flowVersionId: version, ...identity })}`); }
  toJSON() { return { kind: this.kind, id: this.id }; }
}

/** Nullable fields retain their cause instead of turning absent evidence into zero. */
class ExecutionFieldCoverage {
  constructor(value, sources, overrides = {}) {
    this.value = {};
    const visit = (entry, pointer) => {
      if (entry === null) this.value[pointer] = overrides[pointer] ?? { availability: "not-recorded", reason: "PRODUCER_DID_NOT_RECORD", sources };
      else if (entry && typeof entry === "object") {
        for (const [key, child] of Object.entries(entry)) visit(child, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
        if (Object.hasOwn(entry, "value") && entry.value === null && ["not-public", "absolute-path"].includes(entry.reason)) {
          this.value[`${pointer}/value`] = { availability: "unavailable", reason: "NOT_PUBLIC", sources };
        }
      }
    };
    visit(value, "");
    Object.assign(this.value, overrides);
    Object.freeze(this.value);
  }
  toJSON() { return structuredClone(this.value); }
}

class ExecutionBindingView {
  constructor(state, value = {}) {
    this.value = Object.fromEntries(BINDING_FIELDS.map((field) => [field, value[field] ?? null]));
    Object.assign(this.value, { flowVersionId: state.flowVersionId, runId: state.runId, specId: state.specId,
      stepAttemptId: value.stepAttemptId ?? value.attemptId ?? null,
      stepAttemptSequence: value.stepAttemptSequence ?? value.attemptSequence ?? null });
    for (const field of ["flowVersionId", "runId", "specId"]) {
      if (value[field] != null && value[field] !== this.value[field]) inconsistent("Execution binding belongs to another selected Flow Version");
    }
    Object.freeze(this.value);
  }
  toJSON() { return { ...this.value }; }
}

class ExecutionItem {
  constructor(reference, binding, fields, sources, overrides = {}) {
    if (!(reference instanceof ExecutionReference) || !(binding instanceof ExecutionBindingView)) throw new TypeError("Execution item requires typed identity and binding");
    if (reference.kind !== new.target.kind) throw new TypeError("Execution identity differs from its concrete value type");
    const value = { ...reference.toJSON(), label: null, binding: binding.toJSON(),
      timing: { reservedAt: null, startedAt: null, finishedAt: null, durationMs: null }, activityIds: [], diagnosticRefs: [], ...fields, sources };
    this.value = boundedPublic({ ...value, fieldCoverage: new ExecutionFieldCoverage(value, sources, overrides).toJSON() }, "execution");
    if (validateSchema(this.value, itemSchemas.get(new.target.kind)).length > 0) inconsistent("Execution item does not match its concrete public value contract");
    for (const [field, timestamp] of Object.entries(this.value.timing)) if (field !== "durationMs" && timestamp !== null && !isFlowQueryDatetime(timestamp)) inconsistent("Execution has an invalid saved timestamp");
    Object.freeze(this.value);
  }
  get id() { return this.value.id; }
  get kind() { return this.value.kind; }
  toJSON() { return structuredClone(this.value); }
}
class StepAttemptView extends ExecutionItem { static kind = "step-attempt"; }
class AgentInvocationView extends ExecutionItem { static kind = "agent-invocation"; }
class ProviderAttemptView extends ExecutionItem { static kind = "provider-attempt"; }
class ProcessCallView extends ExecutionItem { static kind = "process-call"; }
class OutboxAttemptView extends ExecutionItem { static kind = "outbox-attempt"; }

class ExecutionRelation {
  constructor(version, kind, from, to, sourceIdentity, sources) {
    if (!(from instanceof ExecutionReference) || !(to instanceof ExecutionReference)) throw new TypeError("Execution relation requires typed endpoints");
    this.value = { id: `relation:${digest({ flowVersionId: version, kind, from: from.toJSON(), to: to.toJSON(), sourceIdentity })}`,
      kind, from: from.toJSON(), to: to.toJSON(), sources };
    Object.freeze(this.value);
  }
  toJSON() { return structuredClone(this.value); }
}

class ExecutionMeasurement {
  constructor(state, fact, source) {
    const usage = fact.data.usage;
    const values = { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
      cacheReadTokens: usage?.cache_read_tokens ?? null, cacheCreationTokens: usage?.cache_creation_tokens ?? null, costUsd: usage?.cost_usd ?? null };
    for (const value of Object.values(values)) if (value !== null && (!Number.isFinite(value) || value < 0)) inconsistent("Provider measurement has an invalid numeric value");
    this.value = { measurementId: fact.data.measurementId ?? `measurement:${digest({ flowVersionId: state.flowVersionId, providerAttemptId: fact.entityId })}`,
      subjectRef: ExecutionReference.for(state.flowVersionId, "provider-attempt", { providerAttemptId: fact.entityId }).toJSON(), scope: "provider-attempt", origin: "provider-reported", values,
      coverage: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? "not-recorded" : "complete"])), sources: [source] };
    Object.freeze(this.value);
  }
  toJSON() { return structuredClone(this.value); }
}

/** Runtime acquisition/validation stays in the runtime module; this adapter only selects exact bindings. */
export class QueryExecutionInputs {
  constructor(observations, runtimeSources, receivers, contracts, adoptions) {
    this.observations = observations;
    this.runtimeSources = runtimeSources;
    this.receivers = receivers;
    this.contracts = contracts;
    this.adoptions = adoptions;
    this.digest = digest({ observations, runtimeSources, receivers, contracts, adoptions });
    Object.freeze(this);
  }

  static async capture({ mainRoot, state, activities, catalog, readArtifact, artifactCapture }) {
    let observations;
    try {
      observations = (await captureExecutionObservations({ catalog, readArtifact,
        expectedBinding: { flowVersionId: state.flowVersionId, runId: state.runId, specId: state.specId } })).toJSON();
    } catch (cause) {
      if (cause instanceof QueryError) throw cause;
      inconsistent("Canonical execution observations are inconsistent", cause);
    }
    const attempts = new Set(activities.flatMap((activity) => [activity.attemptId, activity.transition.attempt?.id]).filter(Boolean));
    if (state.attempt) attempts.add(state.attempt.id);
    const runtimeSources = [];
    const seen = new Set();
    for (const manifest of observations.manifests) {
      if (manifest.runtimeSourceId === null || seen.has(manifest.runtimeSourceId)) continue;
      seen.add(manifest.runtimeSourceId);
      try {
        const captured = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot, executionRoot: manifest.checkoutIdentity.executionRoot,
          checkoutIdentity: manifest.checkoutIdentity, runId: state.runId, specId: state.specId });
        const executions = captured.executions.map(serialize).map((execution) => ({ executionId: execution.executionId,
          status: execution.status, calls: execution.calls.map(serialize).filter((call) => {
            const binding = call.binding;
            if (binding === null) return false;
            if (binding.runId !== state.runId || binding.specId !== state.specId) return false;
            if (binding.flowVersionId != null) return binding.flowVersionId === state.flowVersionId;
            return binding.attemptId != null && attempts.has(binding.attemptId);
          }) })).filter((execution) => execution.calls.length > 0);
        runtimeSources.push({ runtimeSourceId: manifest.runtimeSourceId, executions });
      } catch (cause) {
        inconsistent("Referenced execution runtime source could not be verified", cause);
      }
    }
    runtimeSources.sort((left, right) => byteOrder(left.runtimeSourceId, right.runtimeSourceId));
    let receivers;
    let contracts;
    let adoptions;
    try {
      const view = { state, activities, catalog, readCatalogedArtifact: (descriptor) => artifactCapture.read(descriptor) };
      contracts = await artifactCapture.hydrate(() => catalog.artifacts.filter((entry) => entry.logicalKey === "execution.contract").map((descriptor) => {
        const document = JSON.parse(view.readCatalogedArtifact(descriptor).toString("utf8"));
        const contract = FlowExecutionContract.fromJSON(document.contract);
        readExecutionContractFromView(view, contract, { current: false });
        return { id: contract.id, ...contract.toJSON() };
      }));
      receivers = await artifactCapture.hydrate(() => capturePromptExecutionReceiversFromView(view).map((entry) => entry.toJSON()));
      adoptions = await artifactCapture.hydrate(() => capturePromptResponseAdoptionsFromView(view).map((entry) => ({
        ...entry.adoption.toJSON(), acceptedAt: entry.acceptedAt, publicationActivityId: entry.activity.id,
        artifactId: publicArtifactId(entry.descriptor), artifactDigest: entry.descriptor.hash,
        settled: entry.activity.result !== null,
      })));
    } catch (cause) {
      if (cause instanceof QueryError) throw cause;
      inconsistent("Canonical prompt receiver observations are inconsistent", cause);
    }
    return new this(observations, runtimeSources, receivers, contracts, adoptions);
  }
}

/** Aggregate independently measured scopes without treating missing observations as zero. */
export class ExecutionSummary {
  constructor({ items, measurements, legacyMetricCount = 0, unassignedMeasurementCount = 0 }) {
    const count = (kind) => items.filter((item) => item.kind === kind).length;
    const providers = items.filter((item) => item.kind === "provider-attempt");
    const measured = providers.flatMap((item) => item.usageRef === null ? [] : [measurements.get(item.usageRef)]);
    const usage = Object.fromEntries(MEASUREMENT_FIELDS.map((field) => {
      const known = measured.filter((measurement) => measurement.values[field] !== null);
      return [field, { knownTotal: known.reduce((total, measurement) => total + measurement.values[field], 0), measuredSubjects: known.length,
        eligibleSubjects: providers.length, unknownSubjects: providers.length - known.length,
        completeness: known.length === providers.length ? "complete" : "partial" }];
    }));
    const duration = (kind) => {
      const subjects = items.filter((item) => item.kind === kind);
      const values = subjects.filter((item) => item.timing.durationMs !== null);
      return { knownTotalMs: values.reduce((total, item) => total + item.timing.durationMs, 0), measuredSubjects: values.length,
        eligibleSubjects: subjects.length, completeness: values.length === subjects.length ? "complete" : "partial" };
    };
    const starts = items.map((item) => item.timing.startedAt).filter(Boolean).map(Date.parse);
    const ends = items.map((item) => item.timing.finishedAt).filter(Boolean).map(Date.parse);
    this.value = { stepAttemptCount: count("step-attempt"), logicalInvocationCount: count("agent-invocation"), providerAttemptCount: providers.length,
      managedCallCount: count("process-call"), outboxAttemptCount: count("outbox-attempt"),
      cacheHitCount: items.filter((item) => item.kind === "agent-invocation" && item.cache.hit === true).length,
      providerStarts: { confirmed: providers.filter((item) => item.providerStarted === true).length,
        notStarted: providers.filter((item) => item.providerStarted === false).length, unknown: providers.filter((item) => item.providerStarted === null).length },
      providerUsage: usage, logicalDuration: duration("agent-invocation"), processDuration: duration("process-call"),
      observedSpan: { startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
        finishedAt: ends.length ? new Date(Math.max(...ends)).toISOString() : null, completeness: "partial" },
      legacyMetricCount, unassignedMeasurementCount };
    Object.freeze(this.value);
    Object.freeze(this);
  }
  toJSON() { return structuredClone(this.value); }
}

/** The graph only projects producer facts. It never selects a route or changes canonical state. */
export class QueryExecutionGraph {
  constructor({ state, activities, attemptHistory, catalog, inputs }) {
    if (!(inputs instanceof QueryExecutionInputs)) throw new TypeError("Execution graph requires captured inputs");
    if (!(attemptHistory instanceof CurrentFlowAttemptHistory)) throw new TypeError("Execution graph requires captured Attempt lifecycle facts");
    this.state = state;
    this.activities = activities;
    this.attemptHistory = attemptHistory;
    this.catalog = catalog;
    this.inputs = inputs;
    this.items = new Map();
    this.relations = new Map();
    this.measurements = new Map();
    this.measurementBindings = new Map();
    this.extraEndpoints = new Map();
    this.attempts = new Map();
    this.nodes = new Map();
    const walk = (node, taskId = null) => {
      this.nodes.set(node.id, { node, taskId: node.kind === "task" ? node.id : taskId });
      for (const child of node.steps) walk(child, node.kind === "task" ? node.id : taskId);
    };
    walk(state.root);
    this.addAttempts();
    this.addOutboxAttempts();
    this.addObservedInvocations();
    this.addPhysicalCalls();
    this.addMetricMeasurements();
    this.connectObservedRelations();
  }

  ref(kind, identity) { return ExecutionReference.for(this.state.flowVersionId, kind, identity); }
  binding(value) { return new ExecutionBindingView(this.state, value); }
  add(item) {
    if (this.items.has(item.id)) inconsistent("Execution has duplicate public identity");
    this.items.set(item.id, item.toJSON());
  }
  relate(kind, from, to, identity, sources) {
    const relation = new ExecutionRelation(this.state.flowVersionId, kind, from, to, identity, sources).toJSON();
    const previous = this.relations.get(relation.id);
    if (previous && digest(previous) !== digest(relation)) inconsistent("Execution relation identity has conflicting observations");
    this.relations.set(relation.id, relation);
  }
  sourceForFact(fact) {
    const target = FLOW_ARTIFACT_CONTRACTS.resolve("execution.observation", { observationId: fact.id });
    const descriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "execution.observation" && entry.relativePath === target.relativePath);
    if (!descriptor) inconsistent("Execution fact lacks its canonical catalog descriptor");
    return { artifactId: publicArtifactId(descriptor), activityId: null, runtimeSourceId: null, recordId: fact.id, digest: descriptor.hash };
  }
  activitySource(activity) { return { artifactId: null, activityId: activity.id, runtimeSourceId: null, recordId: activity.id, digest: digest(activity.toJSON()) }; }

  addAttempts() {
    const activitiesByAttempt = new Map();
    const remember = (attempt, source) => {
      if (!attempt) return;
      const value = serialize(attempt);
      const existing = this.attempts.get(value.id);
      if (existing && (existing.attempt.nodeId !== value.nodeId || existing.attempt.sequence !== value.sequence || existing.attempt.startedAt !== value.startedAt)) inconsistent("Attempt start facts disagree");
      this.attempts.set(value.id, existing ?? { attempt: value, source });
    };
    for (const activity of this.activities) {
      remember(activity.transition.attempt, this.activitySource(activity));
      if (activity.attemptId !== null) {
        if (!activitiesByAttempt.has(activity.attemptId)) activitiesByAttempt.set(activity.attemptId, []);
        activitiesByAttempt.get(activity.attemptId).push(activity);
      }
    }
    if (this.state.attempt) {
      const descriptor = this.catalog.artifacts.find((entry) => entry.logicalKey === "flow.state");
      remember(this.state.attempt, { artifactId: publicArtifactId(descriptor), activityId: null, runtimeSourceId: null, recordId: this.state.attempt.id, digest: descriptor.hash });
    }
    for (const [id, { attempt, source }] of this.attempts) {
      const activities = activitiesByAttempt.get(id) ?? [];
      const confirmed = activities.filter((activity) => activity.result !== null).at(-1);
      const finish = this.attemptHistory.finishFor(attempt);
      const resultRef = confirmed ? new ExecutionReference("activity", confirmed.id).toJSON() : null;
      const sources = new Map([source, ...[confirmed, finish?.activity].filter(Boolean).map((activity) => this.activitySource(activity))]
        .map((entry) => [entry.recordId, entry]));
      this.add(new StepAttemptView(this.ref("step-attempt", { attemptId: id }), this.binding({ nodeId: attempt.nodeId,
        taskId: this.nodes.get(attempt.nodeId)?.taskId ?? null, attemptId: id, attemptSequence: attempt.sequence }),
      { label: this.nodes.get(attempt.nodeId)?.node.key ?? null, attemptId: id, sequence: attempt.sequence, nodeId: attempt.nodeId,
        startedAt: attempt.startedAt, resultConfirmedAt: confirmed?.result.confirmedAt ?? null, resultRef,
        timing: { reservedAt: null, startedAt: attempt.startedAt, finishedAt: finish?.finishedAt ?? null, durationMs: null },
        activityIds: activities.map((activity) => activity.id) }, [...sources.values()]));
    }
  }

  addObservedInvocations() {
    const grouped = new Map();
    for (const fact of this.inputs.observations.facts) {
      const schema = observationSchemas[fact.kind];
      if (schema === undefined || validateSchema(fact.data, schema).length > 0) inconsistent("Execution observation does not match its supported public source contract");
      if (fact.entityId !== (fact.kind.startsWith("provider-") ? fact.data.providerAttemptId : fact.data.logicalInvocationId)) inconsistent("Execution observation entity differs from its logical identity");
      const key = `${fact.kind.startsWith("provider-") ? "provider" : "agent"}:${fact.entityId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), fact]);
    }
    for (const facts of grouped.values()) {
      const kinds = new Set();
      for (const fact of facts) {
        if (kinds.has(fact.kind)) inconsistent("Execution identity has duplicate start or settlement facts");
        kinds.add(fact.kind);
      }
      facts.sort((left, right) => byteOrder(left.recordedAt, right.recordedAt) || byteOrder(left.id, right.id));
      if (facts[0].kind.startsWith("agent-")) this.addAgent(facts);
      else if (facts[0].kind.startsWith("provider-")) this.addProvider(facts);
    }
  }

  addOutboxAttempts() {
    this.outboxAttempts = CurrentFlowOutboxAttemptHistory.fromActivities(this.activities).attempts;
    this.outboxRefs = new Map();
    for (const attempt of this.outboxAttempts) {
      const reference = this.ref("outbox-attempt", { outboxId: attempt.id, outboxAttempt: attempt.attempt });
      if (attempt.outboxAttemptId !== null) this.outboxRefs.set(attempt.outboxAttemptId, reference);
      const sourceActivities = this.activities.filter((activity) => attempt.sourceActivityIds.includes(activity.id));
      const terminal = sourceActivities.at(-1);
      const fields = this.publicOutbox(attempt);
      this.add(new OutboxAttemptView(reference, this.binding(attempt.executionBinding?.toJSON() ?? {}), { ...fields,
        label: attempt.operation, activityIds: attempt.sourceActivityIds,
        timing: { reservedAt: null, startedAt: attempt.startedAt, finishedAt: attempt.status === "pending" ? null : attempt.updatedAt, durationMs: null } }, sourceActivities.map((activity) => this.activitySource(activity)),
      attempt.failure === null ? {} : { "/failure/message": { availability: "unavailable", reason: "NOT_PUBLIC", sources: sourceActivities.map((activity) => this.activitySource(activity)) } }));
      if (terminal?.result && fields.stepResultRef) this.extraEndpoints.set(fields.stepResultRef.id,
        { ref: fields.stepResultRef, label: terminal.nodeKey, binding: this.binding(attempt.executionBinding?.toJSON() ?? {}).toJSON(), availability: "available", reason: null });
    }
  }

  publicOutbox(attempt) {
    const activity = this.activities.find((entry) => entry.id === attempt.activityId);
    return { outboxId: attempt.id, operation: attempt.operation, outboxAttempt: attempt.attempt, status: attempt.status,
      result: attempt.result === null ? null : new ExecutionReference("activity", attempt.activityId).toJSON(),
      failure: attempt.failure === null ? null : { code: attempt.failureHistory.at(-1)?.code ?? null, message: null },
      recovery: attempt.failureHistory.at(-1)?.recovery ?? null,
      stepResultRef: activity?.result ? new ExecutionReference("activity", activity.id).toJSON() : null };
  }

  publicOutboxForActivity(activity) {
    const outbox = activity.transition.outbox;
    if (outbox === null) return null;
    const history = CurrentFlowOutboxAttemptHistory.fromActivities(this.activities.filter((entry) => entry.confirmationOrder <= activity.confirmationOrder));
    const attempt = history.attempts.find((entry) => entry.id === outbox.id && entry.attempt === outbox.attempt);
    if (!attempt) inconsistent("Activity Outbox does not resolve to its saved attempt");
    return this.publicOutbox(attempt);
  }

  observedBinding(facts) {
    const binding = facts[0].binding;
    if (facts.some((fact) => digest(fact.binding) !== digest(binding))) inconsistent("Invocation changed its start binding");
    return this.exactBinding(binding);
  }

  exactBinding(binding) {
    if (binding.attemptId != null || binding.nodeId != null || binding.attemptSequence != null) {
      const attempt = this.attempts.get(binding.attemptId)?.attempt;
      if (!attempt || attempt.nodeId !== binding.nodeId || attempt.sequence !== binding.attemptSequence) inconsistent("Execution fact refers to a foreign Step Attempt");
    }
    if (binding.executionContractId != null) {
      const contract = this.inputs.contracts.find((entry) => entry.id === binding.executionContractId);
      if (!contract || contract.generation !== binding.executionGeneration || contract.attemptId !== binding.attemptId
        || contract.attemptSequence !== binding.attemptSequence || contract.nodeId !== binding.nodeId || contract.taskId !== binding.taskId
        || contract.runId !== binding.runId || contract.specId !== binding.specId) inconsistent("Execution binding differs from its saved canonical execution contract");
    }
    return this.binding(binding);
  }

  addAgent(facts) {
    const start = facts.find((fact) => fact.kind === "agent-started");
    if (!start) inconsistent("Agent observation is missing its immutable start");
    if (facts.some((fact) => fact.data.requestId !== start.data.requestId)) inconsistent("Agent observation changed its request identity");
    const ready = facts.findLast((fact) => fact.kind === "agent-response-ready");
    const failed = facts.findLast((fact) => fact.kind === "agent-failed");
    const received = this.inputs.receivers.find((entry) => entry.logicalInvocationId === start.entityId);
    if (received && digest(received.binding) !== digest(start.binding)) inconsistent("Prompt receiver differs from logical invocation start binding");
    const binding = this.observedBinding(facts);
    const reference = this.ref("agent-invocation", { logicalInvocationId: start.entityId });
    const caller = this.publicSavedReference(start.data.caller);
    const destination = start.data.responseMode === "return-to-caller" ? caller : this.publicSavedReference(start.data.responseDestination);
    const source = this.sourceForFact(start);
    const cacheHit = ready?.data.cacheOutcome === "hit";
    const response = { origin: ready ? cacheHit ? "cache" : "provider" : null, readyAt: ready?.recordedAt ?? null,
      receivedAt: received?.receivedAt ?? null, recordedAt: received?.receivedAt ?? null, validatedAt: null, acceptedAt: null,
      receiverObservationRef: received ? this.ref("prompt-response", { identity: received }).toJSON() : null, publicationRef: null, settlementRef: null };
    const adoptions = received ? this.inputs.adoptions.filter((adoption) => adoption.selection.receivedResponses.some((entry) => digest(entry) === digest(received))) : [];
    for (const adoption of adoptions) {
      const publication = new ExecutionReference("artifact", adoption.artifactId);
      const adoptionSource = { artifactId: adoption.artifactId, activityId: adoption.publicationActivityId, runtimeSourceId: null, recordId: adoption.id, digest: adoption.artifactDigest };
      this.extraEndpoints.set(publication.id, { ref: publication.toJSON(), label: "prompt-response-adoption", binding: binding.toJSON(), availability: "available", reason: null });
      response.publicationRef ??= publication.toJSON();
      response.acceptedAt ??= adoption.acceptedAt;
      this.relate("accepted-by", reference, publication, { adoptionId: adoption.id, receiver: received }, [adoptionSource]);
      if (adoption.settled) {
        const settlement = this.ref("step-settlement", { activityId: adoption.publicationActivityId });
        this.extraEndpoints.set(settlement.id, { ref: settlement.toJSON(), label: binding.value.nodeId, binding: binding.toJSON(), availability: "available", reason: null });
        response.settlementRef ??= settlement.toJSON();
      }
    }
    const requested = start.data.requested;
    const reported = ready?.data.reported;
    const diagnosticIds = [...new Set(facts.map((fact) => fact.data.requestId).filter((id) => typeof id === "string"))];
    const sources = facts.map((fact) => this.sourceForFact(fact));
    this.add(new AgentInvocationView(reference, binding, { label: start.data.role ?? null, logicalInvocationId: start.entityId,
      commandId: start.data.commandId ?? null, role: start.data.role ?? null, providerKey: requested.provider, profileKey: requested.profileKey,
      requestedModel: requested.model, reportedModel: reported?.model ?? null, requestedEffort: requested.effort, reportedEffort: reported?.effort ?? null,
      caller, responseDestination: destination, responseMode: start.data.responseMode, status: received ? "received" : failed ? "failed" : ready ? "response-ready" : "started",
      response, cache: { hit: ready ? cacheHit : null, sourceInvocationRef: null }, finalResponseUsageRef: null, failure: failed ? this.publicObservedFailure(failed.data.failure) : null,
      timing: { reservedAt: null, startedAt: start.recordedAt, finishedAt: ready?.recordedAt ?? failed?.recordedAt ?? null, durationMs: ready?.data.durationMs ?? failed?.data.durationMs ?? null },
      diagnosticRefs: diagnosticIds.map((id) => this.ref("diagnostic-request", { requestId: id }).toJSON()),
      activityIds: this.activities.filter((activity) => activity.metric?.executionObservation?.logicalInvocationId === start.entityId).map((activity) => activity.id) }, sources,
    cacheHit ? Object.fromEntries(["/reportedModel", "/reportedEffort"].map((path) => [path, { availability: "not-applicable", reason: "NO_PROVIDER_EXECUTION", sources }])) : {}));
    if (caller) this.relate("calls", new ExecutionReference(caller.kind, caller.id), reference, start.id, [source]);
    const outbox = this.outboxRefs.get(start.binding.outboxAttemptId);
    if (outbox) this.relate("part-of-outbox", reference, outbox, start.id, [source]);
    if (received && destination) {
      const receiverRef = this.ref("prompt-response", { identity: received });
      this.extraEndpoints.set(receiverRef.id, { ref: receiverRef.toJSON(), label: "prompt-response", binding: binding.toJSON(), availability: "available", reason: null });
      this.relate("responds-to", reference, new ExecutionReference(destination.kind, destination.id), receiverRef.id, sources);
    }
  }

  addProvider(facts) {
    const start = facts.find((fact) => fact.kind === "provider-started");
    const settled = facts.findLast((fact) => fact.kind === "provider-settled");
    if (!start) inconsistent("Provider observation is missing its immutable reservation");
    for (const field of ["logicalInvocationId", "measurementId", "attemptIndex", "maxAttempts"]) {
      if (settled && settled.data[field] !== start.data[field]) inconsistent("Provider settlement changed its immutable invocation or measurement identity");
    }
    const reference = this.ref("provider-attempt", { providerAttemptId: start.entityId });
    const logical = this.ref("agent-invocation", { logicalInvocationId: start.data.logicalInvocationId });
    const physicalStart = this.inputs.runtimeSources.flatMap((source) => source.executions.flatMap((execution) => execution.calls))
      .find((call) => call.invocation.providerAttemptId === start.entityId
        && (call.outcome?.providerStarted === true || call.launcherObservation?.providerStarted === true));
    const physicalTiming = physicalStart?.outcome?.timing ?? physicalStart?.launcherObservation?.timing;
    const sources = facts.map((fact) => this.sourceForFact(fact));
    if (physicalStart) {
      const runtimeSource = this.inputs.runtimeSources.find((source) => source.executions.some((execution) => execution.calls.includes(physicalStart)));
      sources.push(this.sourceForCall(runtimeSource, physicalStart));
    }
    let measurement = null;
    if (settled) {
      measurement = new ExecutionMeasurement(this.state, settled, this.sourceForFact(settled)).toJSON();
      const previous = this.measurements.get(measurement.measurementId);
      if (previous && digest(previous) !== digest(measurement)) inconsistent("Measurement identity has conflicting saved values");
      this.measurements.set(measurement.measurementId, measurement);
    }
    this.add(new ProviderAttemptView(reference, this.observedBinding(facts), { label: start.data.provider ?? null,
      providerAttemptId: start.entityId, logicalInvocationRef: logical.toJSON(), attempt: start.data.attemptIndex + 1,
      maxAttempts: start.data.maxAttempts ?? settled?.data.maxAttempts ?? null, providerStarted: settled?.data.providerStarted ?? (physicalStart ? true : null),
      status: settled?.data.status ?? (physicalStart ? "started" : "reserved"), requestedModel: start.data.requested?.model ?? null,
      requestedEffort: start.data.requested?.effort ?? null, reportedModel: settled?.data.reported?.model ?? null,
      reportedEffort: settled?.data.reported?.effort ?? null, usageRef: measurement?.measurementId ?? null,
      failure: settled ? this.publicObservedFailure(settled.data.failure) : null,
      timing: { reservedAt: start.recordedAt, startedAt: settled?.data.startedAt ?? physicalTiming?.startedAt ?? null, finishedAt: settled?.data.endedAt ?? null, durationMs: settled?.data.durationMs ?? null } }, sources));
    this.relate("attempt-of", reference, logical, start.id, [this.sourceForFact(start)]);
  }

  publicObservedFailure(failure) {
    return failure == null ? null : { category: failure.category ?? null, code: failure.code ?? null,
      message: failure.message ?? null, retryable: failure.retryable ?? null };
  }

  publicSavedReference(value) {
    if (value == null) return null;
    const version = value.flowVersionId;
    if (typeof version !== "string" || !version) inconsistent("Saved execution reference has no owning Flow Version");
    if (value.kind === "step-attempt") return ExecutionReference.for(version, value.kind, { attemptId: value.id }).toJSON();
    if (value.kind === "agent-invocation") return ExecutionReference.for(version, value.kind, { logicalInvocationId: value.id }).toJSON();
    if (value.kind === "process-call") return this.ref(value.kind, { executionId: value.executionId, callId: value.id }).toJSON();
    if (value.kind === "outbox-attempt") return this.ref(value.kind, { outboxId: value.id, outboxAttempt: value.attempt }).toJSON();
    inconsistent("Saved execution reference has an unsupported kind");
  }

  addPhysicalCalls() {
    for (const source of this.inputs.runtimeSources) for (const execution of source.executions) for (const call of execution.calls) {
      const invocation = call.invocation;
      const sourceRef = this.sourceForCall(source, call);
      const reference = this.ref("process-call", { executionId: execution.executionId, callId: call.callId });
      const parent = call.parentCallId === null ? null : this.ref("process-call", { executionId: execution.executionId, callId: call.parentCallId });
      const logicalId = invocation.logicalInvocationId ?? call.binding.logicalInvocationId;
      const providerId = invocation.providerAttemptId ?? call.binding.providerAttemptId;
      for (const field of ["logicalInvocationId", "providerAttemptId"]) {
        if (invocation[field] != null && call.binding[field] != null && invocation[field] !== call.binding[field]) inconsistent("Physical invocation changed its owning observation identity");
      }
      const providerStart = this.inputs.observations.facts.find((fact) => fact.kind === "provider-started" && fact.entityId === providerId);
      if (providerStart && invocation.measurementId != null && invocation.measurementId !== providerStart.data.measurementId) inconsistent("Physical provider measurement differs from its immutable reservation");
      const logical = logicalId ? this.ref("agent-invocation", { logicalInvocationId: logicalId }) : null;
      const provider = providerId ? this.ref("provider-attempt", { providerAttemptId: providerId }) : null;
      const outcome = call.outcome ?? (call.launcherObservation?.state === "finished" ? call.launcherObservation.outcome : null);
      const timing = call.outcome?.timing ?? call.launcherObservation?.timing;
      const outbox = this.outboxRefs.get(call.binding.outboxAttemptId);
      const controlFailure = call.controlFailure;
      const stop = call.receipt;
      const binding = this.exactBinding(call.binding);
      if (invocation.observationBinding != null) {
        const observed = this.exactBinding(invocation.observationBinding);
        if (digest(binding.toJSON()) !== digest(observed.toJSON())) inconsistent("Physical invocation differs from its saved observation binding");
      }
      for (const related of [logical, provider]) if (related) this.assertRelatedBinding(related, binding);
      if (outbox) this.assertRelatedBinding(outbox, binding, ["flowVersionId", "runId", "specId"]);
      if (logical && provider && this.items.has(provider.id) && this.items.get(provider.id).logicalInvocationRef.id !== logical.id) inconsistent("Physical provider and logical invocation references disagree");
      this.add(new ProcessCallView(reference, binding, { label: invocation.commandId ?? invocation.kind ?? null,
        executionId: execution.executionId, callId: call.callId, parentCallRef: parent?.toJSON() ?? null,
        invocationKind: invocation.kind ?? null, commandId: invocation.commandId ?? null,
        logicalInvocationRef: logical?.toJSON() ?? null, providerAttemptRef: provider?.toJSON() ?? null, outboxAttemptRef: outbox?.toJSON() ?? null,
        command: invocation.command ?? null, physicalStatus: call.status,
        processResult: outcome === null ? null : { exitCode: outcome.exitCode ?? outcome.code ?? null,
          signal: outcome.signal ?? null, startFailureCode: outcome.startFailureCode ?? outcome.error?.code ?? null },
        stopVerification: stop ? "verified" : "unverified", controlFailure: controlFailure ? { code: controlFailure.code ?? null, reason: controlFailure.reason ?? null } : null,
        timing: { reservedAt: invocation.reservedAt ?? null, startedAt: timing?.startedAt ?? null, finishedAt: timing?.finishedAt ?? null, durationMs: timing?.durationMs ?? null } }, [sourceRef],
      call.launcherObservationCoverage === "unavailable" ? Object.fromEntries(["/timing/startedAt", "/timing/finishedAt", "/timing/durationMs"].map((pointer) => [pointer,
        { availability: "unavailable", reason: "LAUNCHER_OBSERVATION_NOT_RETAINED", sources: [sourceRef] }])) : {}));
      if (parent) this.relate("calls", parent, reference, { executionId: execution.executionId, callId: call.callId, parentCallId: call.parentCallId }, [sourceRef]);
      if (provider) this.relate("realizes", reference, provider, { executionId: execution.executionId, callId: call.callId, providerAttemptId: providerId }, [sourceRef]);
      if (outbox) this.relate("part-of-outbox", reference, outbox, { executionId: execution.executionId, callId: call.callId, outboxAttemptId: call.binding.outboxAttemptId }, [sourceRef]);
    }
  }

  sourceForCall(source, call) {
    return { artifactId: null, activityId: null, runtimeSourceId: source.runtimeSourceId, recordId: call.callId, digest: digest(call) };
  }

  assertRelatedBinding(reference, binding, fields = BINDING_FIELDS) {
    const item = this.items.get(reference.id);
    if (!item) return;
    const recorded = binding.toJSON();
    for (const field of fields) if (item.binding[field] !== null && recorded[field] !== null && item.binding[field] !== recorded[field]) inconsistent("Related execution records disagree on their immutable ownership");
  }

  connectObservedRelations() {
    for (const relation of this.relations.values()) {
      if (["attempt-of", "realizes", "part-of-outbox"].includes(relation.kind)) {
        const source = this.items.get(relation.from.id);
        if (source) this.assertRelatedBinding(new ExecutionReference(relation.to.kind, relation.to.id), this.binding({ ...source.binding,
          attemptId: source.binding.stepAttemptId, attemptSequence: source.binding.stepAttemptSequence }), relation.kind === "part-of-outbox" ? ["flowVersionId", "runId", "specId"] : BINDING_FIELDS);
      }
      for (const reference of [relation.from, relation.to]) {
      if (this.items.has(reference.id) || this.extraEndpoints.has(reference.id)) continue;
      // A physical parent or caller may be outside the selected Version's observable scope.
      this.extraEndpoints.set(reference.id, { ref: reference, label: null, binding: null, availability: "unavailable", reason: "REFERENCED_ITEM_NOT_RECORDED" });
      }
    }
  }

  addMetricMeasurements() {
    for (const activity of this.activities) {
      const metric = activity.metric;
      const observation = metric?.executionObservation;
      if (!observation) continue;
      const recorded = observation.toJSON();
      this.exactBinding(recorded.binding);
      const subjectRef = this.ref("agent-invocation", { logicalInvocationId: recorded.logicalInvocationId }).toJSON();
      const measurement = { measurementId: recorded.measurementId, subjectRef, scope: recorded.measurementScope,
        origin: "final-response", values: { inputTokens: metric.tokens?.input ?? null, outputTokens: metric.tokens?.output ?? null,
          cacheReadTokens: metric.tokens?.cacheRead ?? null, cacheCreationTokens: metric.tokens?.cacheCreation ?? null, costUsd: metric.cost },
        coverage: {}, sources: [this.activitySource(activity)] };
      measurement.coverage = Object.fromEntries(Object.entries(measurement.values).map(([key, value]) => [key, metric.cachedResponse ? "not-applicable" : value === null ? "not-recorded" : "complete"]));
      const previous = this.measurements.get(measurement.measurementId);
      if (previous && digest({ ...previous, sources: [] }) !== digest({ ...measurement, sources: [] })) inconsistent("Measurement identity has conflicting saved values");
      if (previous) measurement.sources = [...previous.sources, ...measurement.sources];
      this.measurements.set(measurement.measurementId, measurement);
      this.measurementBindings.set(measurement.measurementId, recorded.binding);
      const agent = this.items.get(subjectRef.id);
      if (agent) {
        agent.finalResponseUsageRef = measurement.measurementId;
        delete agent.fieldCoverage["/finalResponseUsageRef"];
        if (!agent.activityIds.includes(activity.id)) agent.activityIds.push(activity.id);
      }
    }
  }

  activityReferences(activity) {
    return [...this.items.values()].filter((item) => item.activityIds.includes(activity.id)).map((item) => ({ kind: item.kind, id: item.id }));
  }

  targetNodes(target) {
    if (target === null) return new Set(this.nodes.keys());
    if (!this.nodes.has(target.nodeId)) throw new QueryError(FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, "/target/nodeId", "target node is not in the selected Flow Version");
    const nodes = new Set([target.nodeId]);
    const visit = (id) => { for (const child of this.nodes.get(id).node.steps) { nodes.add(child.id); visit(child.id); } };
    if (target.includeDescendants) visit(target.nodeId);
    if (target.attemptId !== null) {
      const attempt = this.attempts.get(target.attemptId)?.attempt;
      if (!attempt || !nodes.has(attempt.nodeId)) throw new QueryError(FLOW_QUERY_ERROR_CODES.INVALID_REQUEST, "/target/attemptId", "target Attempt does not belong to the selected nodes");
    }
    return nodes;
  }

  selected(target) {
    if (target === null) return [...this.items.values()];
    const nodes = this.targetNodes(target);
    return [...this.items.values()].filter((item) => nodes.has(item.binding.nodeId)
      && (target.attemptId === null || item.binding.stepAttemptId === target.attemptId));
  }

  coverage() {
    const manifests = this.inputs.observations.manifests;
    return { sourceHistory: manifests.length === 0 || this.state.history !== null ? "partial" : "observed-only",
      availability: manifests.length === 0 ? "not-recorded" : "available",
      reason: manifests.length === 0 ? "PRODUCER_DID_NOT_RECORD" : null,
      producerCoverage: executionProducerCoverage({ recorded: manifests.length > 0, managedRuntime: manifests.some((manifest) => manifest.runtimeSourceId !== null) }).map(serialize),
      unassignedItemCount: [...this.items.values()].filter((item) => item.binding.nodeId === null).length };
  }

  sourceSummaries() {
    return this.inputs.observations.manifests.map((manifest) => ({ id: manifest.id, runtimeSourceId: manifest.runtimeSourceId,
      recordingStartedAt: manifest.recordingStartedAt, retention: manifest.retention, boundary: manifest.boundary, producerCoverage: manifest.producerCoverage }));
  }

  summary(items = [...this.items.values()], target = null) {
    const nodes = this.targetNodes(target);
    const targetActivities = target === null ? this.activities : this.activities.filter((activity) => nodes.has(activity.nodeId) && (target.attemptId === null || activity.attemptId === target.attemptId));
    const unassignedMeasurementCount = [...this.measurements.values()].filter((measurement) => {
      if (this.items.has(measurement.subjectRef.id)) return false;
      const binding = this.measurementBindings.get(measurement.measurementId);
      return target === null || binding != null && nodes.has(binding.nodeId) && (target.attemptId === null || binding.attemptId === target.attemptId);
    }).length;
    return new ExecutionSummary({ items, measurements: this.measurements,
      legacyMetricCount: targetActivities.filter((activity) => activity.metric !== null && activity.metric.executionObservation === null).length,
      unassignedMeasurementCount }).toJSON();
  }

  page(items) {
    const ids = new Set(items.map((item) => item.id));
    const relations = [...this.relations.values()].filter((relation) => ids.has(relation.from.id) || ids.has(relation.to.id));
    const endpointRefs = new Map();
    for (const relation of relations) for (const reference of [relation.from, relation.to]) if (!ids.has(reference.id)) endpointRefs.set(reference.id, reference);
    for (const item of items) {
      const references = [...item.diagnosticRefs, ...["caller", "responseDestination", "parentCallRef", "logicalInvocationRef", "providerAttemptRef", "outboxAttemptRef", "resultRef", "stepResultRef"].map((field) => item[field])];
      if (item.kind === "agent-invocation") references.push(item.response.receiverObservationRef, item.response.publicationRef, item.response.settlementRef);
      if (item.kind === "outbox-attempt") references.push(item.result);
      for (const reference of references) if (reference && !ids.has(reference.id)) endpointRefs.set(reference.id, reference);
    }
    const endpoints = [...endpointRefs.values()].sort((left, right) => byteOrder(left.id, right.id)).map((ref) => {
      const item = this.items.get(ref.id);
      const activity = ref.kind === "activity" ? this.activities.find((entry) => entry.id === ref.id) : null;
      return item ? { ref, label: item.label, binding: item.binding, availability: "available", reason: null }
        : this.extraEndpoints.get(ref.id) ?? { ref, label: activity?.nodeKey ?? null, binding: null,
          availability: activity ? "available" : "unavailable", reason: activity ? null : ref.kind === "diagnostic-request" ? "RETENTION_NOT_PROVEN" : "REFERENCED_ITEM_NOT_RECORDED" };
    });
    const measurementIds = new Set(items.flatMap((item) => [item.usageRef, item.finalResponseUsageRef]).filter(Boolean));
    const measurements = [...measurementIds].sort(byteOrder).map((id) => {
      const measurement = this.measurements.get(id);
      if (!measurement) inconsistent("Execution usage reference is unresolved");
      return measurement;
    });
    return { items, relations: relations.sort((left, right) => byteOrder(left.id, right.id)), endpoints, measurements };
  }
}

/** The executions cursor is bound to both selection and observed source generation. */
export class ExecutionCursor {
  constructor(request, snapshotId, afterId) {
    this.payload = { version: 1, schemaRevision: 3, resource: "executions", specId: request.specId, flowVersion: request.flowVersion,
      target: request.target, snapshotId, afterId };
  }
  encode() {
    return Buffer.from(JSON.stringify(canonicalJson({ ...this.payload, digest: digest(this.payload) }))).toString("base64url");
  }
  static decode(value, request, snapshotId = null) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      const { digest: hash, ...content } = payload;
      const expectedFields = ["version", "schemaRevision", "resource", "specId", "flowVersion", "target", "snapshotId", "afterId", "digest"].sort().join();
      if (Object.keys(payload).sort().join() !== expectedFields || hash !== digest(content) || content.version !== 1 || content.schemaRevision !== 3
        || content.resource !== "executions" || typeof content.afterId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(content.snapshotId)
        || validateFlowQueryRequest({ resource: content.resource, condition: { specId: content.specId, flowVersion: content.flowVersion },
          page: { limit: 1, after: null }, ...(content.target === null ? {} : { target: content.target }) }).length > 0
        || Buffer.from(JSON.stringify(canonicalJson(payload))).toString("base64url") !== value) throw new Error("Invalid execution cursor");
    } catch (cause) {
      throw new QueryError(FLOW_QUERY_ERROR_CODES.INVALID_CURSOR, "/page/after", "execution cursor is invalid", { cause });
    }
    if (payload.specId !== request.specId || payload.flowVersion !== request.flowVersion || digest(payload.target) !== digest(request.target)) {
      throw new QueryError(FLOW_QUERY_ERROR_CODES.CURSOR_QUERY_MISMATCH, "/page/after", "execution cursor belongs to another query");
    }
    if (snapshotId !== null && payload.snapshotId !== snapshotId) throw new QueryError(FLOW_QUERY_ERROR_CODES.SNAPSHOT_CHANGED, "/page/after", "execution cursor snapshot changed");
    return payload.afterId;
  }
}

export function projectExecutionPage({ graph, request, snapshot, envelope }) {
  const selected = graph.selected(request.target).sort((left, right) => byteOrder(left.id, right.id));
  const after = request.page.after === null ? null : ExecutionCursor.decode(request.page.after, request, snapshot.id);
  if (after !== null && !selected.some((item) => item.id === after)) throw new QueryError(FLOW_QUERY_ERROR_CODES.INVALID_CURSOR, "/page/after", "execution cursor position is not in its snapshot");
  const remaining = selected.filter((item) => after === null || byteOrder(item.id, after) > 0);
  const items = [];
  const response = () => ({ ...envelope, ...graph.page(items), summary: graph.summary(selected, request.target), coverage: graph.coverage(),
    pageInfo: { limit: request.page.limit, endCursor: items.length ? new ExecutionCursor(request, snapshot.id, items.at(-1).id).encode() : null,
      hasNext: remaining.length > items.length, returnedItems: items.length, totalItems: selected.length } });
  for (const item of remaining.slice(0, request.page.limit)) {
    items.push(item);
    if (Buffer.byteLength(JSON.stringify(response()) + "\n") > FLOW_QUERY_LIMITS.MAX_RESPONSE_BYTES) {
      items.pop();
      if (items.length === 0) throw new QueryError(FLOW_QUERY_ERROR_CODES.RESPONSE_TOO_LARGE, "/response", "one execution and its reference closure exceed the response byte limit");
      break;
    }
  }
  return response();
}
