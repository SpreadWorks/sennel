import { isDeepStrictEqual } from "node:util";
import { ProcessExecutionBinding, ProcessExecutionCheckoutIdentity, executionUuid,
  executionValueSnapshot, executionValueDigest, ProcessExecutionStopReceipt, ProcessExecutionInvocationDisclosure } from "./process-execution-values.js";
import { ManagedStopOperationValue } from "./managed-stop-operation-value.js";

/** An exact live coordinator revoked a reservation before any launch permit. */
export class ProcessExecutionReservationRevocation {
  constructor({ schemaVersion, scope, executionId, callId, ownerEpoch, checkoutIdentity,
    binding, invocation, invocationDigest, closureRevision, reason, stopOperation }) {
    if (schemaVersion !== 2 || scope !== "unlaunched-reservation") throw new TypeError("Reservation revocation has an unsupported schema or scope");
    this.schemaVersion = schemaVersion; this.scope = scope;
    this.executionId = executionUuid(executionId, "Revocation execution ID");
    this.callId = executionUuid(callId, "Revocation call ID");
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || !Number.isSafeInteger(closureRevision) || closureRevision < 1
      || typeof reason !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(reason)) throw new TypeError("Reservation revocation identity or reason is invalid");
    this.ownerEpoch = ownerEpoch; this.closureRevision = closureRevision; this.reason = reason;
    this.checkoutIdentity = checkoutIdentity instanceof ProcessExecutionCheckoutIdentity ? checkoutIdentity : new ProcessExecutionCheckoutIdentity(checkoutIdentity);
    this.binding = new ProcessExecutionBinding(binding);
    const disclosure = new ProcessExecutionInvocationDisclosure({ invocation, invocationDigest });
    this.invocation = disclosure.invocation; this.invocationDigest = disclosure.invocationDigest;
    this.stopOperation = stopOperation === null ? null : ManagedStopOperationValue.fromStored(stopOperation.toJSON?.() ?? stopOperation);
    Object.freeze(this);
  }
  toJSON() { return { schemaVersion: this.schemaVersion, scope: this.scope, executionId: this.executionId, callId: this.callId,
    ownerEpoch: this.ownerEpoch, checkoutIdentity: this.checkoutIdentity.toJSON(), binding: this.binding.toJSON(),
    invocation: executionValueSnapshot(this.invocation), invocationDigest: this.invocationDigest, closureRevision: this.closureRevision, reason: this.reason,
    stopOperation: this.stopOperation?.toJSON() ?? null }; }
  static fromStored(value) {
    const restored = new ProcessExecutionReservationRevocation(value);
    if (!isDeepStrictEqual(value, restored.toJSON())) throw new TypeError("Reservation revocation has missing or unknown fields");
    return restored;
  }
}


/** Exact digest and kind of one completed reservation, without conflating facts. */
export class ProcessExecutionCallClosure {
  constructor({ callId, closureKind, closureDigest }) {
    this.callId = executionUuid(callId, "Closure call ID");
    if (!["child-exit", "reservation-revoked"].includes(closureKind)
      || typeof closureDigest !== "string" || !/^[a-f0-9]{64}$/.test(closureDigest)) throw new TypeError("Call closure kind or digest is invalid");
    this.closureKind = closureKind; this.closureDigest = closureDigest;
    Object.freeze(this);
  }
  static fromFact(fact) {
    if (!(fact instanceof ProcessExecutionStopReceipt) && !(fact instanceof ProcessExecutionReservationRevocation)) throw new TypeError("Call closure requires exact typed completion evidence");
    return new ProcessExecutionCallClosure({ callId: fact.callId, closureKind: fact instanceof ProcessExecutionStopReceipt ? "child-exit" : "reservation-revoked", closureDigest: executionValueDigest(fact) });
  }
  toJSON() { return { callId: this.callId, closureKind: this.closureKind, closureDigest: this.closureDigest }; }
  static fromStored(value) {
    const restored = new ProcessExecutionCallClosure(value);
    if (!isDeepStrictEqual(value, restored.toJSON())) throw new TypeError("Call closure has missing or unknown fields");
    return restored;
  }
}
