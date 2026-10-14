import crypto from "node:crypto";
import { ProcessExecutionCheckoutIdentity } from "../../lib/process-execution-values.js";
import { FlowProcessExecutionBinding } from "./flow-process-execution-binding.js";
import { PromptExecutionJournalWriter, PromptExecutionJournalSnapshot, PromptExecutionScope } from "../../lib/prompt-execution-journal.js";
import { FlowExecutionContract, executionValueDigest } from "./flow-execution-contract.js";

/** Save-only adapter; the existing canonical Store owns every read and transaction. */
export class CanonicalPromptExecutionJournalWriter extends PromptExecutionJournalWriter {
  #flowManager;
  #snapshotDigest;
  constructor({ flowManager, executionContract, scope, snapshot = null, processExecutionBinding = null, checkoutIdentity = null }) {
    super();
    if (!(executionContract instanceof FlowExecutionContract) || !(scope instanceof PromptExecutionScope)
      || snapshot !== null && !(snapshot instanceof PromptExecutionJournalSnapshot)) throw new TypeError("Canonical prompt writer requires typed execution inputs");
    this.#flowManager = flowManager;
    this.executionContract = executionContract;
    this.scope = scope;
    if (checkoutIdentity !== null && !(checkoutIdentity instanceof ProcessExecutionCheckoutIdentity)) throw new TypeError("Prompt writer checkout identity must be typed");
    this.checkoutIdentity = checkoutIdentity;
    this.processExecutionBinding = FlowProcessExecutionBinding.forContract(executionContract, { baseBinding: processExecutionBinding });
    this.#snapshotDigest = snapshot === null ? null : executionValueDigest(snapshot.toJSON());
    Object.freeze(this);
  }
  async save(record) {
    this.#flowManager.savePromptExecutionProgress({ executionContract: this.executionContract,
      scope: this.scope, record, expectedCheckoutIdentity: this.checkoutIdentity, expectedSnapshotDigest: this.#snapshotDigest, operationId: crypto.randomUUID() });
    this.#snapshotDigest = executionValueDigest(record.snapshot.toJSON());
  }
}
