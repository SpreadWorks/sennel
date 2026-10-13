import crypto from "node:crypto";
import { PromptExecutionJournalWriter, PromptExecutionJournalSnapshot, PromptExecutionScope } from "../../lib/prompt-execution-journal.js";
import { FlowExecutionContract, executionValueDigest } from "./flow-execution-contract.js";

/** Save-only adapter; the existing canonical Store owns every read and transaction. */
export class CanonicalPromptExecutionJournalWriter extends PromptExecutionJournalWriter {
  #flowManager;
  #snapshotDigest;
  constructor({ flowManager, executionContract, scope, snapshot = null }) {
    super();
    if (!(executionContract instanceof FlowExecutionContract) || !(scope instanceof PromptExecutionScope)
      || snapshot !== null && !(snapshot instanceof PromptExecutionJournalSnapshot)) throw new TypeError("Canonical prompt writer requires typed execution inputs");
    this.#flowManager = flowManager;
    this.executionContract = executionContract;
    this.scope = scope;
    this.#snapshotDigest = snapshot === null ? null : executionValueDigest(snapshot.toJSON());
    Object.freeze(this);
  }
  async save(record) {
    this.#flowManager.savePromptExecutionProgress({ executionContract: this.executionContract,
      scope: this.scope, record, expectedSnapshotDigest: this.#snapshotDigest, operationId: crypto.randomUUID() });
    this.#snapshotDigest = executionValueDigest(record.snapshot.toJSON());
  }
}
