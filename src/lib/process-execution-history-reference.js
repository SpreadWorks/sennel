import { ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { ProcessExecutionCheckoutIdentity, executionValueExact, executionValueSnapshot, freezeExecutionValue } from "./process-execution-values.js";

/** Retained readback location, never an execution grant or currentness proof. */
export class ProcessExecutionHistoryReference {
  #storage;
  constructor(value) {
    const { storage, checkoutIdentity } = value;
    this.#storage = freezeExecutionValue(executionValueSnapshot(ReadOnlyProcessRuntimeStorage.validateGrant(storage)));
    this.checkoutIdentity = new ProcessExecutionCheckoutIdentity(checkoutIdentity);
    executionValueExact(value, this.toJSON());
    Object.freeze(this);
  }
  static fromStored(value) {
    if (value instanceof ProcessExecutionHistoryReference) return value;
    return new this(value);
  }
  toJSON() { return { storage: executionValueSnapshot(this.#storage), checkoutIdentity: this.checkoutIdentity.toJSON() }; }
  async read(options = {}) {
    const { ProcessExecutionRuntime } = await import("./process-execution-runtime.js");
    return ProcessExecutionRuntime.readHistoricalInventory({ ...options,
      mainRoot: this.checkoutIdentity.mainRoot, executionRoot: this.checkoutIdentity.executionRoot,
      checkoutIdentity: this.checkoutIdentity, storagePolicy: ReadOnlyProcessRuntimeStorage.fromGrant(this.#storage) });
  }
}
