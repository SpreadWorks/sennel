import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionCheckoutIdentity, executionValueDigest } from "./process-execution-values.js";

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
}
function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${field} is invalid`);
  return value;
}
function timestamp(value) {
  if (Number.isNaN(Date.parse(text(value, "Observation timestamp")))) throw new TypeError("Observation timestamp is invalid");
  return value;
}
function immutable(value) {
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) immutable(member);
    Object.freeze(value);
  }
  return value;
}
function json(value) { return immutable(JSON.parse(JSON.stringify(value))); }
function exact(value, expected, name) {
  if (!isDeepStrictEqual(value, expected)) throw new TypeError(`${name} has unknown, missing, or invalid fields`);
}
function assertVersion(actual, expected) {
  if (expected === null) return;
  for (const field of ["flowVersionId", "runId", "specId"]) {
    if (actual[field] !== expected[field]) throw new TypeError(`Execution observation ${field} differs from its selected Version`);
  }
}

const OBSERVATION_ARTIFACT_KEYS = new Set(["execution.source.manifest", "execution.observation", "execution.response.adoption"]);
export function isFlowExecutionObservationArtifact(logicalKey) { return OBSERVATION_ARTIFACT_KEYS.has(logicalKey); }

/** Captured once, before work starts; it remains valid after the cursor advances. */
export class FlowExecutionObservationBinding {
  constructor({ flowVersionId, runId, specId, nodeId, taskId = null, attemptId,
    attemptSequence, executionContractId = null, executionGeneration = null, outboxAttemptId = null }) {
    for (const [field, value] of Object.entries({ flowVersionId, runId, specId, nodeId, attemptId })) this[field] = text(value, field);
    this.taskId = taskId === null ? null : text(taskId, "taskId");
    this.attemptSequence = integer(attemptSequence, "attemptSequence", 1);
    this.executionContractId = executionContractId === null ? null : text(executionContractId, "executionContractId");
    this.executionGeneration = executionGeneration === null ? null : integer(executionGeneration, "executionGeneration");
    if ((this.executionContractId === null) !== (this.executionGeneration === null)) throw new TypeError("Execution contract identity and generation must be paired");
    this.outboxAttemptId = outboxAttemptId === null ? null : text(outboxAttemptId, "outboxAttemptId");
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
  static fromJSON(value) {
    const binding = new this(value);
    exact(value, binding.toJSON(), "Execution observation binding");
    return binding;
  }
  assertVersion(expected) { assertVersion(this, expected); return this; }
  forOutboxAttempt(id, attempt) {
    return new FlowExecutionObservationBinding({ ...this.toJSON(),
      outboxAttemptId: executionValueDigest([this.flowVersionId, text(id, "Outbox ID"), integer(attempt, "Outbox attempt", 1)]) });
  }
  assertOutboxAttempt(id, attempt) {
    if (this.outboxAttemptId !== this.forOutboxAttempt(id, attempt).outboxAttemptId) throw new TypeError("Outbox starting binding differs from its Attempt identity");
    return this;
  }
}

export class FlowExecutionProducerCoverage {
  constructor({ producer, status, boundary }) {
    this.producer = text(producer, "Observation producer");
    if (!["available", "not-recorded", "outside-managed-scope"].includes(status)) throw new TypeError("Observation producer coverage is invalid");
    this.status = status;
    this.boundary = text(boundary, "Observation producer boundary");
    Object.freeze(this);
  }
  toJSON() { return { ...this }; }
}

export function executionProducerCoverage({ recorded = false, managedRuntime = false } = {}) {
  return Object.freeze([
    ...["agent-invocation", "provider-attempt", "outbox-attempt"].map((producer) => new FlowExecutionProducerCoverage({
      producer, status: recorded ? "available" : "not-recorded", boundary: recorded ? "after-source-registration" : "no-source-registration" })),
    new FlowExecutionProducerCoverage({ producer: "process-call", status: recorded && managedRuntime ? "available" : "not-recorded",
      boundary: recorded && managedRuntime ? "managed-launcher-after-source-registration" : "no-managed-runtime-source-registration" }),
    ...["synchronous-command", "unmanaged-async-command", "direct-spawn", "provider-internal-tool", "outer-agent"].map((producer) => new FlowExecutionProducerCoverage({
      producer, status: "outside-managed-scope", boundary: "outside-managed-launcher" })),
  ]);
}

/** An immutable source registration. New checkouts append another registration. */
export class FlowExecutionSourceManifest {
  constructor({ schemaRevision = 1, id, flowVersionId, runId, specId, recordingStartedAt,
    runtimeSourceId = null, checkoutIdentity = null, checkoutNamespace = null,
    retention = "permanent", producerCoverage, boundary }) {
    if (schemaRevision !== 1 || retention !== "permanent") throw new TypeError("Execution source manifest format is invalid");
    Object.assign(this, { schemaRevision, id: text(id, "Execution source ID"), flowVersionId: text(flowVersionId, "flowVersionId"),
      runId: text(runId, "runId"), specId: text(specId, "specId"), recordingStartedAt: timestamp(recordingStartedAt),
      runtimeSourceId: runtimeSourceId === null ? null : text(runtimeSourceId, "Runtime source ID"),
      checkoutIdentity: checkoutIdentity === null ? null : json(new ProcessExecutionCheckoutIdentity(checkoutIdentity).toJSON()),
      checkoutNamespace: checkoutNamespace === null ? null : text(checkoutNamespace, "Checkout namespace"), retention });
    if ((runtimeSourceId === null) !== (checkoutIdentity === null) || (runtimeSourceId === null) !== (checkoutNamespace === null)) {
      throw new TypeError("Execution runtime source identity must be complete");
    }
    if (runtimeSourceId !== null && (runtimeSourceId !== executionValueDigest(checkoutIdentity) || checkoutNamespace !== runtimeSourceId)
      || id !== executionValueDigest([flowVersionId, runId, specId, runtimeSourceId])) {
      throw new TypeError("Execution source manifest identity differs from its retained binding");
    }
    if (!Array.isArray(producerCoverage)) throw new TypeError("Execution source producer coverage is required");
    this.producerCoverage = Object.freeze(producerCoverage.map((entry) => entry instanceof FlowExecutionProducerCoverage ? entry : new FlowExecutionProducerCoverage(entry)));
    if (new Set(this.producerCoverage.map((entry) => entry.producer)).size !== this.producerCoverage.length) throw new TypeError("Execution source producers repeat");
    this.boundary = Object.freeze({ confirmationOrder: integer(boundary?.confirmationOrder, "Source confirmation boundary"),
      activityCount: integer(boundary?.activityCount, "Source Activity boundary") });
    Object.freeze(this);
  }
  toJSON() { return { ...this, producerCoverage: this.producerCoverage.map((entry) => entry.toJSON()) }; }
  static fromJSON(value) { const manifest = new this(value); exact(value, manifest.toJSON(), "Execution source manifest"); return manifest; }
  assertVersion(expected) { assertVersion(this, expected); return this; }
  assertSameSource(expected) {
    this.assertVersion(expected);
    if (this.runtimeSourceId !== expected.runtimeSourceId || this.checkoutNamespace !== expected.checkoutNamespace
      || !isDeepStrictEqual(this.checkoutIdentity, expected.checkoutIdentity)) throw new TypeError("Execution source registration changed its retained identity");
    return this;
  }
}

/** A fact is independently immutable; no mutable logical-call record is authoritative. */
export class FlowExecutionObservationFact {
  constructor({ id, sourceId, kind, entityId, recordedAt, binding, data }) {
    this.id = text(id, "Observation ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new TypeError("Observation ID must be a path identifier");
    this.sourceId = text(sourceId, "Observation source ID");
    this.kind = text(kind, "Observation kind");
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new TypeError("Observation kind is invalid");
    this.entityId = text(entityId, "Observation entity ID");
    this.recordedAt = timestamp(recordedAt);
    this.binding = binding instanceof FlowExecutionObservationBinding ? binding : FlowExecutionObservationBinding.fromJSON(binding);
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Observation data must be an object");
    this.data = json(data);
    Object.freeze(this);
  }
  toJSON() { return { ...this, binding: this.binding.toJSON() }; }
  static fromJSON(value) { const fact = new this(value); exact(value, fact.toJSON(), "Execution observation fact"); return fact; }
}

export class FlowExecutionObservationSession {
  constructor({ binding, sourceId, record }) {
    if (!(binding instanceof FlowExecutionObservationBinding) || typeof record !== "function") throw new TypeError("Observation session requires a typed binding and record capability");
    this.binding = binding;
    this.sourceId = text(sourceId, "Observation source ID");
    this.record = record;
    Object.freeze(this);
  }
  append({ id = crypto.randomUUID(), kind, entityId, recordedAt = new Date().toISOString(), data }) {
    const fact = new FlowExecutionObservationFact({ id, sourceId: this.sourceId, kind, entityId, recordedAt, binding: this.binding, data });
    this.record(fact);
    return fact;
  }
}

export class FlowExecutionMeasurementReference {
  constructor({ binding, logicalInvocationId, requestId = null, measurementId, measurementScope = "final-logical-response" }) {
    this.binding = binding instanceof FlowExecutionObservationBinding ? binding : FlowExecutionObservationBinding.fromJSON(binding);
    this.logicalInvocationId = text(logicalInvocationId, "Metric logical invocation ID");
    this.requestId = requestId === null ? null : text(requestId, "Metric request ID");
    this.measurementId = text(measurementId, "Metric measurement ID");
    this.measurementScope = text(measurementScope, "Metric measurement scope");
    Object.freeze(this);
  }
  toJSON() { return { ...this, binding: this.binding.toJSON() }; }
}

export class FlowExecutionObservationCapture {
  constructor({ manifests, facts, expectedBinding = null }) {
    this.manifests = Object.freeze(manifests.map((manifest) => manifest.assertVersion(expectedBinding)));
    this.facts = Object.freeze(facts.map((fact) => {
      fact.binding.assertVersion(expectedBinding);
      const source = this.manifests.find((manifest) => manifest.id === fact.sourceId);
      if (!source) throw new TypeError("Execution observation source manifest is absent");
      fact.binding.assertVersion(source);
      return fact;
    }));
    if (new Set(this.manifests.map((source) => source.id)).size !== manifests.length
      || new Set(this.facts.map((fact) => fact.id)).size !== facts.length) throw new TypeError("Execution observation identity repeats");
    Object.freeze(this);
  }
  toJSON() { return { manifests: this.manifests.map((manifest) => manifest.toJSON()), facts: this.facts.map((fact) => fact.toJSON()) }; }
}

function observationDescriptors(catalog) {
  return catalog.artifacts.filter((descriptor) => isFlowExecutionObservationArtifact(descriptor.logicalKey)
    && descriptor.logicalKey !== "execution.response.adoption");
}

function parseObservationArtifact(descriptor, bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (descriptor.logicalKey === "execution.source.manifest") {
    const manifest = FlowExecutionSourceManifest.fromJSON(value);
    if (descriptor.relativePath !== `artifacts/execution-observations/sources/${manifest.id}.json`) throw new TypeError("Execution source manifest path differs from its identity");
    return manifest;
  }
  const fact = FlowExecutionObservationFact.fromJSON(value);
  if (descriptor.relativePath !== `artifacts/execution-observations/facts/${fact.id}.json`) throw new TypeError("Execution observation path differs from its identity");
  return fact;
}

function captureObservationRecords(records, expectedBinding) {
  return new FlowExecutionObservationCapture({ expectedBinding,
    manifests: records.filter((record) => record instanceof FlowExecutionSourceManifest),
    facts: records.filter((record) => record instanceof FlowExecutionObservationFact) });
}

/** Pure parsing of already captured, catalog-verified bytes. No runtime or filesystem access. */
export async function captureExecutionObservations({ catalog, readArtifact, expectedBinding = null }) {
  const records = [];
  for (const descriptor of observationDescriptors(catalog)) records.push(parseObservationArtifact(descriptor, await readArtifact(descriptor)));
  return captureObservationRecords(records, expectedBinding);
}

/** The same parser for an existing synchronous canonical transaction view. */
export function captureExecutionObservationsFromView(view) {
  return captureObservationRecords(observationDescriptors(view.catalog).map((descriptor) =>
    parseObservationArtifact(descriptor, view.readCatalogedArtifact(descriptor))), view.state);
}
