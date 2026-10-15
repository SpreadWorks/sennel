import { ArtifactWorkerRecoveryEvidence, ArtifactWorkerRecoveryReceipt } from "../lib/artifact-worker-recovery-values.js";
import { ArtifactWorkerRecoveryPublication } from "../lib/artifact-worker-execution-recovery.js";
import { DraftWorkerRecoveryCheckpoint } from "../lib/draft-worker-recovery-checkpoint.js";

/** Save-only capability assembled outside the Service from acquired inputs. */
export class ArtifactWorkerRecoveryWriter {
  #flowManager;
  #inputs;
  constructor({ flowManager, sourceRequest, targetRequest, physicalEvidence, consumption,
    binding, conditionalExecutionState = null, targetContentDigest = null, evidence }) {
    this.#flowManager = flowManager;
    if (!(evidence instanceof ArtifactWorkerRecoveryEvidence)) throw new TypeError("Recovery writer requires authenticated evidence");
    this.#inputs = { evidence, sourceRequest, targetRequest, physicalEvidence, consumption,
      binding, conditionalExecutionState, targetContentDigest };
    Object.freeze(this);
  }
  save({ result, settlement }) {
    const receipt = new ArtifactWorkerRecoveryReceipt({ evidence: this.#inputs.evidence, result: result.toJSON(), settlement: settlement.toJSON() });
    const { evidence, binding, conditionalExecutionState, targetContentDigest, ...inputs } = this.#inputs;
    const checkpoint = conditionalExecutionState === null ? null : new DraftWorkerRecoveryCheckpoint({
      binding, executionState: conditionalExecutionState, recovery: receipt,
      targetRequest: inputs.targetRequest, targetContentDigest,
    });
    return this.#flowManager.saveArtifactWorkerRecovery({
      publication: new ArtifactWorkerRecoveryPublication({ receipt, ...inputs,
        checkpoint, sourceExecutionReceiptId: conditionalExecutionState?.receiptId ?? null }),
    });
  }
}
