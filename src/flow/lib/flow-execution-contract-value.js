/** Nominal value boundary for authenticated execution contracts, without runtime IO. */
export class FlowExecutionContractValue {
  constructor() {
    if (new.target === FlowExecutionContractValue) throw new TypeError("Execution contract values are abstract");
  }
}

/** Nominal value boundary for durable artifact worker recovery authorizations. */
export class ArtifactWorkerRecoveryReceiptValue {
  constructor() {
    if (new.target === ArtifactWorkerRecoveryReceiptValue) throw new TypeError("Artifact recovery receipt values are abstract");
  }
}
