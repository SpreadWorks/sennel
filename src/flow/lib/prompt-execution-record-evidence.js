import { PromptExecutionJournalSnapshot } from "../../lib/prompt-execution-journal.js";
import { ProcessExecutionRecoveryCall, ProcessExecutionRecoveryEvidenceSummary } from "../../lib/process-execution-values.js";
import { executionValueDigest } from "./flow-execution-contract.js";

/** Canonical identity retains each typed fact's producer encoding. Every raw
 * record field remains in the digest, including fields its consumer may refuse.
 * The catalog independently checks actual current artifact bytes. Opaque
 * provider output, invocation and binding data are never traversed as evidence.
 */
export class PromptExecutionRecordEvidence {
  constructor(value) {
    let projected;
    if (value.event === "physical-accounted") {
      const summary = ProcessExecutionRecoveryEvidenceSummary.fromSaved(value.physicalEvidence);
      projected = { ...value, physicalEvidence: { ...value.physicalEvidence, ...summary.toEvidenceJSON() },
        calls: value.calls.map(call => new ProcessExecutionRecoveryCall(call).toEvidenceStored()) };
    } else {
      projected = { ...value, snapshot: PromptExecutionJournalSnapshot.evidenceValue(value.snapshot) };
    }
    // Own only the immutable digest. Do not clone/freeze opaque response bodies
    // just to hash a record synchronously at its existing verification boundary.
    this.digest = executionValueDigest(projected);
    Object.freeze(this);
  }
  static digest(value) { return new this(value).digest; }
}
