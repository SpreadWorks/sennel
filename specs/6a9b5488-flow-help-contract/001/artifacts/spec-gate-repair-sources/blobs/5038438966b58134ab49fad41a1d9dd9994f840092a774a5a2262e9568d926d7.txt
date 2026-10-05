/**
 * Immutable facts shared by every definition-owned transition except Gate.
 *
 * Step modules may attach one typed NonGateStepFacts value.  The common
 * boundary owns identity, catalog, lineage, completion and policy facts; a
 * step module owns only the evidence that is unique to that step.
 */

const RECOVERY_KINDS = new Set(["none", "retry", "repair", "record-and-proceed", "park"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value, field) {
  return value == null ? null : requiredText(value, field);
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function requiredObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} must be a plain object`);
  return value;
}

function immutableValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("non-Gate immutable values must contain only arrays, plain objects, and primitives");
  }
  for (const entry of Object.values(value)) immutableValue(entry);
  return Object.freeze(value);
}

/** Stable current-Attempt identity assigned by the canonical Version Store. */
export class NonGateAttemptIdentity {
  constructor({ id, sequence } = {}) {
    this.id = requiredText(id, "non-Gate Attempt id");
    this.sequence = positiveInteger(sequence, "non-Gate Attempt sequence");
    Object.freeze(this);
  }

  matches(other) {
    return other instanceof NonGateAttemptIdentity && this.id === other.id && this.sequence === other.sequence;
  }

  toJSON() { return { id: this.id, sequence: this.sequence }; }
}

/** Immutable catalog publication for the observed non-Gate result. */
export class NonGateCatalogPublication {
  constructor({ runId, specId, stepId, attemptId, sequence, producerActivityId, artifactId, fingerprint } = {}) {
    this.runId = requiredText(runId, "non-Gate catalog runId");
    this.specId = requiredText(specId, "non-Gate catalog specId");
    this.stepId = requiredText(stepId, "non-Gate catalog producer stepId");
    this.attempt = new NonGateAttemptIdentity({ id: attemptId, sequence });
    this.producerActivityId = requiredText(producerActivityId, "non-Gate catalog producer activityId");
    this.artifactId = requiredText(artifactId, "non-Gate catalog artifactId");
    this.fingerprint = requiredText(fingerprint, "non-Gate catalog fingerprint");
    Object.freeze(this);
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      stepId: this.stepId,
      attemptId: this.attempt.id,
      sequence: this.attempt.sequence,
      producerActivityId: this.producerActivityId,
      artifactId: this.artifactId,
      fingerprint: this.fingerprint,
    };
  }
}

/** Existing catalog evidence owned by an upstream source Step. */
export class NonGateSourcePublication extends NonGateCatalogPublication {}
/** Optional catalog evidence emitted by a repair Step. */
export class NonGateRepairPublication extends NonGateCatalogPublication {}

/** Binds source, canonical and optional repair evidence to one revision. */
export class NonGateLineage {
  constructor({
    sourceAttempt, canonicalAttempt, sourceFingerprint, canonicalFingerprint,
    sourceRevisionFingerprint = null, canonicalRevisionFingerprint = null,
    repairAttempt = null, repairFingerprint = null, repairRevisionFingerprint = null,
  } = {}) {
    this.sourceAttempt = sourceAttempt instanceof NonGateAttemptIdentity
      ? sourceAttempt : new NonGateAttemptIdentity(sourceAttempt);
    this.canonicalAttempt = canonicalAttempt instanceof NonGateAttemptIdentity
      ? canonicalAttempt : new NonGateAttemptIdentity(canonicalAttempt);
    this.sourceFingerprint = requiredText(sourceFingerprint, "non-Gate source fingerprint");
    this.canonicalFingerprint = requiredText(canonicalFingerprint, "non-Gate canonical fingerprint");
    this.sourceRevisionFingerprint = optionalText(sourceRevisionFingerprint, "non-Gate source revision fingerprint");
    this.canonicalRevisionFingerprint = optionalText(canonicalRevisionFingerprint, "non-Gate canonical revision fingerprint");
    if ((this.sourceRevisionFingerprint === null) !== (this.canonicalRevisionFingerprint === null)) {
      throw new Error("non-Gate lineage revision bindings must be present together");
    }
    this.repairAttempt = repairAttempt == null ? null : (repairAttempt instanceof NonGateAttemptIdentity
      ? repairAttempt : new NonGateAttemptIdentity(repairAttempt));
    this.repairFingerprint = optionalText(repairFingerprint, "non-Gate repair fingerprint");
    this.repairRevisionFingerprint = optionalText(repairRevisionFingerprint, "non-Gate repair revision fingerprint");
    if ((this.repairAttempt === null) !== (this.repairFingerprint === null)) {
      throw new Error("non-Gate repair lineage requires Attempt and fingerprint together");
    }
    if (this.repairAttempt === null && this.repairRevisionFingerprint !== null) {
      throw new Error("empty non-Gate repair lineage must not carry a revision binding");
    }
    if (this.repairAttempt !== null && this.sourceRevisionFingerprint !== null && this.repairRevisionFingerprint === null) {
      throw new Error("revision-bound non-Gate repair lineage requires a repair revision binding");
    }
    if (this.repairAttempt !== null && this.sourceRevisionFingerprint === null && this.repairRevisionFingerprint !== null) {
      throw new Error("physical non-Gate repair lineage must not carry a revision binding");
    }
    Object.freeze(this);
  }

  get isCurrent() {
    return (this.sourceRevisionFingerprint === null
        ? this.sourceFingerprint === this.canonicalFingerprint
        : this.sourceRevisionFingerprint === this.canonicalRevisionFingerprint)
      && (this.repairAttempt === null || (
        (this.sourceRevisionFingerprint === null
          ? this.repairFingerprint === this.canonicalFingerprint
          : this.repairRevisionFingerprint === this.canonicalRevisionFingerprint)
      ));
  }

  toJSON() {
    return {
      sourceAttempt: this.sourceAttempt.toJSON(),
      canonicalAttempt: this.canonicalAttempt.toJSON(),
      sourceFingerprint: this.sourceFingerprint,
      canonicalFingerprint: this.canonicalFingerprint,
      sourceRevisionFingerprint: this.sourceRevisionFingerprint,
      canonicalRevisionFingerprint: this.canonicalRevisionFingerprint,
      repairAttempt: this.repairAttempt?.toJSON() ?? null,
      repairFingerprint: this.repairFingerprint,
      repairRevisionFingerprint: this.repairRevisionFingerprint,
    };
  }
}

/** Persisted recovery evidence may narrow a decision, never authorize an ad-hoc route. */
export class NonGateRecoveryEvidence {
  constructor({ kind = "none", attempt = null, fingerprint = null } = {}) {
    this.kind = requiredText(kind, "non-Gate recovery kind");
    if (!RECOVERY_KINDS.has(this.kind)) throw new Error("non-Gate recovery kind is invalid");
    this.attempt = attempt == null ? null : (attempt instanceof NonGateAttemptIdentity ? attempt : new NonGateAttemptIdentity(attempt));
    this.fingerprint = optionalText(fingerprint, "non-Gate recovery fingerprint");
    if ((this.kind === "none") !== (this.attempt === null && this.fingerprint === null)) {
      throw new Error("empty non-Gate recovery evidence must not carry a binding");
    }
    if (this.kind !== "none" && (this.attempt === null || this.fingerprint === null)) {
      throw new Error("non-Gate recovery evidence requires Attempt and fingerprint");
    }
    Object.freeze(this);
  }

  isBoundTo(lineage) {
    if (!(lineage instanceof NonGateLineage)) throw new Error("non-Gate recovery lineage must be typed");
    if (this.attempt === null) return true;
    if (this.kind === "repair" && lineage.repairAttempt !== null) {
      return this.attempt.matches(lineage.repairAttempt) && this.fingerprint === lineage.repairFingerprint;
    }
    return this.attempt.matches(lineage.canonicalAttempt) && this.fingerprint === lineage.canonicalFingerprint;
  }

  toJSON() { return { kind: this.kind, attempt: this.attempt?.toJSON() ?? null, fingerprint: this.fingerprint }; }
}

/** Completion facts are explicit so partially settled work cannot be advanced by inference. */
export class NonGateCompletionFacts {
  constructor({ completed = false, partial = false } = {}) {
    if (typeof completed !== "boolean" || typeof partial !== "boolean") {
      throw new Error("non-Gate completion facts must be boolean");
    }
    if (completed && partial) throw new Error("completed non-Gate facts cannot be partial");
    this.completed = completed;
    this.partial = partial;
    Object.freeze(this);
  }

  toJSON() { return { completed: this.completed, partial: this.partial }; }
}

/** Retry accounting is read from canonical state; commands never reconstruct it. */
export class NonGateRetryMetrics {
  constructor({ used = 0, maximum = 1 } = {}) {
    this.used = nonNegativeInteger(used, "non-Gate retry used");
    this.maximum = positiveInteger(maximum, "non-Gate retry maximum");
    Object.freeze(this);
  }

  get exhausted() { return this.used >= this.maximum; }
  toJSON() { return { used: this.used, maximum: this.maximum, remaining: Math.max(0, this.maximum - this.used) }; }
}

/**
 * Extension point for facts unique to one non-Gate Step.  Subclasses retain
 * their own behaviour and serialize through toJSON(); the common reducer
 * treats them as opaque evidence and does not inspect step semantics.
 */
export class NonGateStepFacts {
  constructor({ kind, values = {} } = {}) {
    if (new.target === NonGateStepFacts) throw new Error("non-Gate Step facts require a dedicated subclass");
    this.kind = requiredText(kind, "non-Gate step facts kind");
    requiredObject(values, "non-Gate step facts values");
    this.values = immutableValue(structuredClone(values));
    Object.freeze(this);
  }

  value(name) { return this.values[requiredText(name, "non-Gate step facts value name")]; }

  toJSON() { return { kind: this.kind, values: structuredClone(this.values) }; }
}

/** Producer ownership binds catalog publication to the exact non-Gate leaf. */
export class NonGateProducerOwnership {
  constructor({ runId, specId, activityId, stepId, attempt } = {}) {
    this.runId = requiredText(runId, "non-Gate producer runId");
    this.specId = requiredText(specId, "non-Gate producer specId");
    this.activityId = requiredText(activityId, "non-Gate producer activityId");
    this.stepId = requiredText(stepId, "non-Gate producer stepId");
    this.attempt = attempt instanceof NonGateAttemptIdentity ? attempt : new NonGateAttemptIdentity(attempt);
    Object.freeze(this);
  }

  toJSON() {
    return { runId: this.runId, specId: this.specId, activityId: this.activityId, stepId: this.stepId, attempt: this.attempt.toJSON() };
  }
}

/** Target ownership prevents one non-Gate Step from consuming another's result. */
export class NonGateTargetBinding {
  constructor({ runId, specId, stepId, attempt } = {}) {
    this.runId = requiredText(runId, "non-Gate target runId");
    this.specId = requiredText(specId, "non-Gate target specId");
    this.stepId = requiredText(stepId, "non-Gate target stepId");
    this.attempt = attempt instanceof NonGateAttemptIdentity ? attempt : new NonGateAttemptIdentity(attempt);
    Object.freeze(this);
  }

  toJSON() { return { runId: this.runId, specId: this.specId, stepId: this.stepId, attempt: this.attempt.toJSON() }; }
}

/** Complete canonical input to the generic Definition reducer. */
export class NonGateTransitionFacts {
  constructor({
    runId,
    specId,
    stepId,
    snapshotRevision,
    producer,
    target,
    currentAttempt,
    catalogPublication,
    sourcePublication,
    repairPublication = null,
    lineage,
    retry = {},
    recoveryEvidence = {},
    completion = {},
    nonblocking = false,
    stepFacts = null,
    integrityFailure = null,
  } = {}) {
    this.runId = requiredText(runId, "non-Gate runId");
    this.specId = requiredText(specId, "non-Gate specId");
    this.stepId = requiredText(stepId, "non-Gate stepId");
    this.snapshotRevision = requiredText(snapshotRevision, "non-Gate snapshot revision");
    this.producer = producer instanceof NonGateProducerOwnership ? producer : new NonGateProducerOwnership(producer);
    this.target = target instanceof NonGateTargetBinding ? target : new NonGateTargetBinding(target);
    this.currentAttempt = currentAttempt instanceof NonGateAttemptIdentity
      ? currentAttempt : new NonGateAttemptIdentity(currentAttempt);
    this.catalogPublication = catalogPublication instanceof NonGateCatalogPublication
      ? catalogPublication : new NonGateCatalogPublication(catalogPublication);
    this.sourcePublication = sourcePublication instanceof NonGateSourcePublication
      ? sourcePublication : new NonGateSourcePublication(sourcePublication);
    this.repairPublication = repairPublication === null ? null : (repairPublication instanceof NonGateRepairPublication
      ? repairPublication : new NonGateRepairPublication(repairPublication));
    this.lineage = lineage instanceof NonGateLineage ? lineage : new NonGateLineage(lineage);
    this.retry = retry instanceof NonGateRetryMetrics ? retry : new NonGateRetryMetrics(retry);
    this.recoveryEvidence = recoveryEvidence instanceof NonGateRecoveryEvidence
      ? recoveryEvidence : new NonGateRecoveryEvidence(recoveryEvidence);
    this.completion = completion instanceof NonGateCompletionFacts ? completion : new NonGateCompletionFacts(completion);
    if (typeof nonblocking !== "boolean") throw new Error("non-Gate nonblocking must be boolean");
    this.nonblocking = nonblocking;
    if (stepFacts !== null && !(stepFacts instanceof NonGateStepFacts)) {
      throw new Error("non-Gate transition facts require typed step facts");
    }
    this.stepFacts = stepFacts;
    this.explicitIntegrityFailure = integrityFailure === null ? null : requiredText(integrityFailure, "non-Gate integrity failure");
    Object.freeze(this);
  }

  get integrityFailure() {
    if (this.explicitIntegrityFailure !== null) return this.explicitIntegrityFailure;
    if (this.producer.runId !== this.runId || this.producer.specId !== this.specId || this.producer.stepId !== this.stepId) {
      return "producer_ownership_mismatch";
    }
    if (this.target.runId !== this.runId || this.target.specId !== this.specId || this.target.stepId !== this.stepId) {
      return "target_binding_mismatch";
    }
    if (!this.currentAttempt.matches(this.producer.attempt) || !this.currentAttempt.matches(this.target.attempt)) {
      return "target_attempt_mismatch";
    }
    if (this.catalogPublication.runId !== this.runId
      || this.catalogPublication.specId !== this.specId
      || this.catalogPublication.stepId !== this.stepId) return "catalog_ownership_mismatch";
    if (this.sourcePublication.runId !== this.runId || this.sourcePublication.specId !== this.specId) {
      return "source_catalog_ownership_mismatch";
    }
    if (this.repairPublication !== null
      && (this.repairPublication.runId !== this.runId || this.repairPublication.specId !== this.specId)) {
      return "repair_catalog_ownership_mismatch";
    }
    if (this.producer.activityId !== this.catalogPublication.producerActivityId) return "catalog_producer_mismatch";
    if (!this.currentAttempt.matches(this.catalogPublication.attempt)) return "attempt_catalog_mismatch";
    if (this.catalogPublication.fingerprint !== this.lineage.canonicalFingerprint) return "catalog_lineage_mismatch";
    if (this.sourcePublication.fingerprint !== this.lineage.sourceFingerprint) return "source_catalog_lineage_mismatch";
    if (!this.sourcePublication.attempt.matches(this.lineage.sourceAttempt)) return "source_attempt_lineage_mismatch";
    if ((this.repairPublication === null) !== (this.lineage.repairAttempt === null)) return "repair_publication_lineage_mismatch";
    if (this.repairPublication !== null && (
      this.repairPublication.fingerprint !== this.lineage.repairFingerprint
      || !this.repairPublication.attempt.matches(this.lineage.repairAttempt)
    )) return "repair_catalog_lineage_mismatch";
    if (!this.currentAttempt.matches(this.lineage.canonicalAttempt)) return "attempt_lineage_mismatch";
    if (!this.lineage.isCurrent) return "source_canonical_repair_lineage_mismatch";
    if (!this.recoveryEvidence.isBoundTo(this.lineage)) return "recovery_lineage_mismatch";
    return null;
  }

  static fromPersisted(value, { stepFacts } = {}) {
    requiredObject(value, "persisted non-Gate transition facts");
    if (typeof stepFacts !== "function") throw new Error("persisted non-Gate transition facts require a typed step facts decoder");
    const restoredStepFacts = value.stepFacts === null || value.stepFacts === undefined ? null : stepFacts(value.stepFacts);
    return new NonGateTransitionFacts({ ...value, stepFacts: restoredStepFacts });
  }

  toJSON() {
    return {
      runId: this.runId, specId: this.specId, stepId: this.stepId, snapshotRevision: this.snapshotRevision,
      producer: this.producer.toJSON(), target: this.target.toJSON(),
      currentAttempt: this.currentAttempt.toJSON(),
      catalogPublication: this.catalogPublication.toJSON(),
      sourcePublication: this.sourcePublication.toJSON(),
      repairPublication: this.repairPublication?.toJSON() ?? null,
      lineage: this.lineage.toJSON(), retry: this.retry.toJSON(),
      recoveryEvidence: this.recoveryEvidence.toJSON(), completion: this.completion.toJSON(),
      nonblocking: this.nonblocking, stepFacts: this.stepFacts?.toJSON() ?? null,
      integrityFailure: this.explicitIntegrityFailure,
    };
  }
}
