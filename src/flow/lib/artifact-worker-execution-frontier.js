import { PromptExecutionReservationContinuation } from "../../lib/prompt-execution-journal.js";
import { FlowExecutionContractValue, ArtifactWorkerRecoveryReceiptValue } from "./flow-execution-contract-value.js";

/** Acquired catalog identities; phase owners retain their semantic frontier. */
export class ArtifactWorkerExecutionFrontier {
  constructor({ contracts, recovery = null, status = null, reservationContinuation = null }) {
    if (!Array.isArray(contracts) || contracts.some((contract) => !(contract instanceof FlowExecutionContractValue))
      || recovery !== null && !(recovery instanceof ArtifactWorkerRecoveryReceiptValue)
      || ![null, "unconsumed", "reserved", "accepted"].includes(status)
      || reservationContinuation !== null && !(reservationContinuation instanceof PromptExecutionReservationContinuation)) {
      throw new TypeError("Artifact worker frontier requires authenticated catalog facts");
    }
    const ordered = [...contracts].sort((a, b) => a.generation - b.generation);
    if (new Set(ordered.map((contract) => contract.generation)).size !== ordered.length
      || ordered.some((contract) => contract.episodeId !== ordered[0].episodeId)
      || recovery !== null && !ordered.some((contract) => contract.id === recovery.targetContractId)) {
      throw new TypeError("Artifact worker frontier has inconsistent generations or recovery authorization");
    }
    this.contracts = Object.freeze(ordered);
    this.executionContract = ordered.at(-1) ?? null;
    this.recovery = recovery;
    this.status = status;
    this.reservationContinuation = reservationContinuation;
    Object.freeze(this);
  }
}
