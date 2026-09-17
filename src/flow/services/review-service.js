/** Review-cycle evidence operations for a Connector-bound Flow step. */
export class ReviewService {
  constructor({ flowManager, binding }) {
    this.flowManager = flowManager;
    this.binding = binding;
  }

  /** Read the Review result selected by the binding. */
  readReview() {
    throw new Error("ReviewService.readReview() is not implemented");
  }

  /** Validate and publish a Review result with its reviewed source revision. */
  saveReview(review) {
    throw new Error("ReviewService.saveReview() is not implemented");
  }

  /** Read the triage record associated with the selected Review result. */
  readTriage() {
    throw new Error("ReviewService.readTriage() is not implemented");
  }

  /** Validate and publish a triage record linked to the selected Review. */
  saveTriage(triage) {
    throw new Error("ReviewService.saveTriage() is not implemented");
  }

  /** Read the repair record associated with the selected triage. */
  readRepairRecord() {
    throw new Error("ReviewService.readRepairRecord() is not implemented");
  }

  /** Validate and publish a repair record linked to the selected triage. */
  saveRepairRecord(repairRecord) {
    throw new Error("ReviewService.saveRepairRecord() is not implemented");
  }

  /** Read canonical Review attempt history without selecting a different revision. */
  readHistory() {
    throw new Error("ReviewService.readHistory() is not implemented");
  }
}
