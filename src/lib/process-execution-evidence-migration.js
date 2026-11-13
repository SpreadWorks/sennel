/** Explicit previous-evidence conversion. Ordinary runtime readers stay current-only. */
import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionCheckoutIdentity, ProcessExecutionControlFailure,
  ProcessExecutionStopReceipt, executionValueDigest, executionValueSnapshot,
  executionValueExact, freezeExecutionValue, ProcessExecutionNonExecutionEvidence, ProcessExecutionRecoveryEvidenceSummary } from "./process-execution-values.js";
import { ProcessExecutionReservationRevocation, ProcessExecutionCallClosure } from "./process-execution-reservation-revocation.js";
import { ProcessExecutionEvidenceCodec } from "./process-execution-evidence-codec.js";
import { ProcessCheckoutEvidenceEncoding } from "./process-checkout-evidence-encoding.js";

/** Numeric predecessor tokens are accepted only here and only when lossless. */
class PreviousCheckoutIdentity {
  constructor(value) {
    const encoding = new ProcessCheckoutEvidenceEncoding(value, { previous: true });
    this.current = new ProcessExecutionCheckoutIdentity(encoding.decimals);
    this.original = freezeExecutionValue(encoding.toJSON());
    executionValueExact(value, this.original);
    Object.freeze(this);
  }
}

/** The original wire and its validated current shape share one immutable fact. */
class PreviousCompletionFact {
  constructor(value) {
    const checkout = new PreviousCheckoutIdentity(value.checkoutIdentity);
    const projected = { ...value, checkoutIdentity: checkout.original };
    let current;
    if (value.scope === "registered-executions" && value.schemaVersion === 3) {
      current = new ProcessExecutionStopReceipt({ ...projected, schemaVersion: 4 });
      this.kind = "child-exit";
    } else if (value.scope === "unlaunched-reservation" && value.schemaVersion === 2) {
      current = ProcessExecutionReservationRevocation.fromStored({ ...projected, schemaVersion: 3 });
      this.kind = "reservation-revoked";
    } else {
      throw new TypeError("Previous completion fact requires a supported exact source version");
    }
    const original = { ...current.toJSON(), schemaVersion: value.schemaVersion, checkoutIdentity: checkout.original };
    if (!isDeepStrictEqual(value, original)) throw new TypeError("Previous completion fact has inconsistent fields");
    this.original = freezeExecutionValue(original);
    this.projected = freezeExecutionValue(current.toJSON());
    this.digest = executionValueDigest(this.original);
    this.callId = current.callId;
    Object.freeze(this);
  }
}

/** Exact source/target evidence; its provenance must still be bound by the publisher. */
export class ProcessExecutionEvidenceMigrationMapping {
  constructor(source, target) {
    if (!(source instanceof PreviousCompletionFact)
      || !(target instanceof ProcessExecutionStopReceipt || target instanceof ProcessExecutionReservationRevocation)
      || source.callId !== target.callId) throw new TypeError("Evidence mapping requires its exact typed source and target");
    this.callId = source.callId;
    this.kind = source.kind;
    this.sourceDigest = source.digest;
    this.targetDigest = executionValueDigest(target);
    if (source.digest !== target.evidenceDigest) throw new TypeError("Migration changed the original completion proof identity");
    this.source = source.original;
    this.target = target;
    Object.freeze(this);
  }
  toJSON() { return { callId: this.callId, kind: this.kind, sourceDigest: this.sourceDigest,
    targetDigest: this.targetDigest, source: executionValueSnapshot(this.source), target: this.target.toJSON() }; }
}

/** One complete stopped source graph owns child digest conversion, never a PID. */
export class ProcessExecutionEvidenceMigration {
  #facts = new Map();
  #converted = new Map();
  #active = new Set();

  static checkout(value) { return new PreviousCheckoutIdentity(value).current; }

  /** A canonical receipt retains its original descendant references. Complete
   * runtime inventory validation, rather than this leaf codec, owns membership. */
  static retainedCompletion(value) {
    const fact = new PreviousCompletionFact(value);
    const current = fact.kind === "child-exit" ? new ProcessExecutionStopReceipt(fact.projected)
      : ProcessExecutionReservationRevocation.fromStored(fact.projected);
    if (current.evidenceDigest !== fact.digest) throw new TypeError("Retained completion changed its producer evidence identity");
    return current;
  }

  static recoverySummary(value) {
    const { id, digest, ...source } = value;
    if (source.schemaVersion !== 3 || id !== digest || digest !== executionValueDigest(source)) throw new TypeError("Previous saved recovery observation differs from its source digest");
    let nonExecution = null;
    if (source.nonExecution !== null) {
      if (source.nonExecution.schemaVersion !== 1) throw new TypeError("Previous non-execution evidence has an unsupported version");
      nonExecution = new ProcessExecutionNonExecutionEvidence({ ...source.nonExecution, schemaVersion: 2,
        checkoutIdentity: source.nonExecution.checkoutIdentity });
      executionValueExact(source.nonExecution, { ...nonExecution.toJSON(), schemaVersion: 1, checkoutIdentity: source.nonExecution.checkoutIdentity });
    }
    const current = new ProcessExecutionRecoveryEvidenceSummary({ ...source, schemaVersion: 4,
      checkoutIdentity: source.checkoutIdentity, nonExecution: nonExecution?.toJSON() ?? null });
    if (current.evidenceDigest !== digest) throw new TypeError("Migrated recovery summary changed its original producer identity");
    return { ...value, ...current.toJSON() };
  }

  static failure(value) {
    if (value?.schemaVersion !== 2 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) {
      throw new TypeError("Previous failure lacks valid bounded version-two evidence");
    }
    let communication = null;
    if (value.communication !== null) {
      const source = value.communication;
      if (source?.schemaVersion !== 1 || !["unknown", "confirmed"].includes(source.stopConfirmation)) {
        throw new TypeError("Previous communication confirmation or version is invalid");
      }
      const { stopConfirmation, ...retained } = source;
      communication = { ...retained, schemaVersion: 2, stopConfirmed: stopConfirmation === "confirmed" };
    }
    const current = ProcessExecutionControlFailure.fromStored({ ...value, schemaVersion: 3, communication });
    let originalCommunication = null;
    if (current.communication !== null) {
      const { stopConfirmed, ...retained } = current.communication.toJSON();
      originalCommunication = { ...retained, schemaVersion: 1, stopConfirmation: stopConfirmed ? "confirmed" : "unknown" };
    }
    executionValueExact(value, { ...current.toJSON(), schemaVersion: 2, communication: originalCommunication });
    return current;
  }

  /** Only protocol-owned fields are converted; invocation, binding and output
   * are opaque user data even if they happen to resemble evidence objects. */
  response(operation, response) {
    if (response === null) return null;
    const result = executionValueSnapshot(response);
    if (result.ok === false) {
      result.error = ProcessExecutionEvidenceMigration.failure(result.error).toJSON();
      return result;
    }
    if (result.ok !== true) throw new TypeError("Previous request response has no protocol disposition");
    if (operation === "finish" || operation === "revoke-reservation") {
      const current = this.completion(result.value);
      const projected = { ...result.value, schemaVersion: current.schemaVersion };
      executionValueExact(projected, current);
      result.value = projected;
    } else if (["failure", "delegated-failure"].includes(operation)) {
      result.value = ProcessExecutionEvidenceMigration.failure(result.value).toJSON();
    } else if (["read-control", "close", "seal"].includes(operation) && result.value !== null) {
      const control = operation === "read-control" && Object.hasOwn(result.value, "control") ? result.value.control : result.value;
      if (control.controlFailure != null) control.controlFailure = ProcessExecutionEvidenceMigration.failure(control.controlFailure).toJSON();
    }
    return result;
  }

  addCompletion(value) {
    const fact = new PreviousCompletionFact(value);
    const previous = this.#facts.get(fact.digest);
    if (previous !== undefined && !isDeepStrictEqual(previous.original, fact.original)) {
      throw new TypeError("Previous completion digest has conflicting source facts");
    }
    this.#facts.set(fact.digest, fact);
    return fact.digest;
  }

  #convert(digest) {
    if (this.#converted.has(digest)) return this.#converted.get(digest);
    const fact = this.#facts.get(digest);
    if (fact === undefined) throw new TypeError("Previous descendant completion lacks its original exact source fact");
    if (this.#active.has(digest)) throw new TypeError("Previous descendant completion graph contains a cycle");
    this.#active.add(digest);
    try {
      const projected = executionValueSnapshot(fact.projected);
      if (fact.kind === "child-exit") {
        projected.descendants = fact.original.descendants.map((value) => {
          const reference = ProcessExecutionCallClosure.fromStored(value);
          const source = this.#facts.get(reference.closureDigest);
          if (source?.callId !== reference.callId || source.kind !== reference.closureKind) {
            throw new TypeError("Previous descendant reference differs from its exact completion fact");
          }
          return ProcessExecutionCallClosure.fromFact(this.#convert(reference.closureDigest)).toJSON();
        });
      }
      const current = fact.kind === "child-exit" ? new ProcessExecutionStopReceipt(projected)
        : ProcessExecutionReservationRevocation.fromStored(projected);
      executionValueExact(projected, current);
      this.#converted.set(digest, current);
      return current;
    } finally { this.#active.delete(digest); }
  }

  completion(value) {
    const source = new PreviousCompletionFact(value);
    const registered = this.#facts.get(source.digest);
    if (registered === undefined || !isDeepStrictEqual(registered.original, source.original)) {
      throw new TypeError("Completion conversion requires its registered complete source graph");
    }
    return this.#convert(source.digest);
  }

  mappings() {
    return [...this.#facts].map(([digest, fact]) => {
      const target = this.#convert(digest);
      return new ProcessExecutionEvidenceMigrationMapping(fact, target);
    });
  }
}

/** Source-only views retain original wire bytes/digests while reusing current
 * semantic validation. They never escape as current published evidence. */
class PreviousCheckoutView extends ProcessExecutionCheckoutIdentity {
  #original;
  constructor(value) {
    const source = new PreviousCheckoutIdentity(value);
    super(source.current.toJSON());
    this.#original = source.original;
  }
  toJSON() { return executionValueSnapshot(this.#original); }
}

class PreviousReceiptView extends ProcessExecutionStopReceipt {
  #original;
  constructor(value) {
    const source = new PreviousCompletionFact(value);
    if (source.kind !== "child-exit") throw new TypeError("Previous receipt view requires a child exit");
    super(source.projected);
    this.#original = source.original;
  }
  toJSON() { return executionValueSnapshot(this.#original); }
}

class PreviousRevocationView extends ProcessExecutionReservationRevocation {
  #original;
  constructor(value) {
    const source = new PreviousCompletionFact(value);
    if (source.kind !== "reservation-revoked") throw new TypeError("Previous revocation view requires an unlaunched reservation");
    super(source.projected);
    this.#original = source.original;
  }
  toJSON() { return executionValueSnapshot(this.#original); }
}

class PreviousFailureView extends ProcessExecutionControlFailure {
  #original;
  constructor(value, context = {}) {
    const projected = ProcessExecutionEvidenceMigration.failure(value);
    ProcessExecutionControlFailure.fromStored(projected.toJSON(), context);
    super(projected.reason, projected.message, { executionId: projected.executionId, callId: projected.callId,
      diagnostic: projected.diagnostic, primaryCause: projected.primaryCause, communication: projected.communication });
    this.#original = freezeExecutionValue(executionValueSnapshot(value));
  }
  toJSON() { return executionValueSnapshot(this.#original); }
  withStopConfirmation(stopConfirmation) {
    const confirmed = this.communication?.withStopConfirmation(stopConfirmation);
    const original = this.toJSON();
    if (confirmed !== undefined) original.communication.stopConfirmation = confirmed.stopConfirmation;
    return new PreviousFailureView(original);
  }
}

/** Explicit predecessor reader. Current storage always uses the current codec. */
export class PreviousProcessExecutionEvidenceCodec extends ProcessExecutionEvidenceCodec {
  checkout(value) { return new PreviousCheckoutView(value); }
  receipt(value) { return new PreviousReceiptView(value); }
  revocation(value) { return new PreviousRevocationView(value); }
  failure(value, context = {}) { return new PreviousFailureView(value, context); }
}
