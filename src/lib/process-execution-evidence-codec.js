import { ProcessExecutionCheckoutIdentity, ProcessExecutionControlFailure, ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { ProcessExecutionReservationRevocation } from "./process-execution-reservation-revocation.js";

/** Shared semantic leaf decoding; storage selects the codec, never stored input. */
export class ProcessExecutionEvidenceCodec {
  constructor() { Object.freeze(this); }
  checkout(value) { return new ProcessExecutionCheckoutIdentity(value); }
  receipt(value) { return new ProcessExecutionStopReceipt(value); }
  revocation(value) { return ProcessExecutionReservationRevocation.fromStored(value); }
  failure(value, context = {}) { return ProcessExecutionControlFailure.fromStored(value, context); }
}

export const CURRENT_PROCESS_EXECUTION_EVIDENCE = new ProcessExecutionEvidenceCodec();
