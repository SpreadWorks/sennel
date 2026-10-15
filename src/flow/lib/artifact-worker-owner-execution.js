import { ArtifactWorkerExecutionFrontier } from "./artifact-worker-recovery-values.js";
import { FlowExecutionContractRefusal } from "./flow-execution-contract.js";

/** The phase owner's semantic frontier, with an exact saved replacement when present. */
export class ArtifactWorkerOwnerExecution {
  constructor({ frontier, generation, budgetOwner = null }) {
    if (!(frontier instanceof ArtifactWorkerExecutionFrontier)
      || !Number.isSafeInteger(generation) || generation < 0
      || budgetOwner !== null && (typeof budgetOwner !== "string" || !budgetOwner)) {
      throw new TypeError("Artifact owner execution requires its canonical frontier and owner generation");
    }
    this.generation = generation;
    this.budgetOwner = budgetOwner;
    this.executionContract = null;
    this.recovery = null;
    const recovery = frontier.recovery;
    if (recovery !== null && frontier.executionContract?.id === recovery.targetContractId
      && generation <= recovery.targetGeneration) {
      if (budgetOwner !== null && budgetOwner !== recovery.sourceContract.budgetOwner) {
        throw new FlowExecutionContractRefusal("Artifact recovery cannot replace the phase owner's execution budget");
      }
      this.generation = recovery.targetGeneration;
      this.budgetOwner = recovery.targetContract.budgetOwner;
      this.executionContract = recovery.targetContract;
      this.recovery = recovery;
    }
    Object.freeze(this);
  }
}
