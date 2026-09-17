import { StepConnector } from "../../step-connector.js";

/** Binds the Draft revision consumed by a questions or coverage review. */
export class DraftReviewConnector extends StepConnector {
  async connect() {
    throw new Error("DraftReviewConnector.connect() is not implemented");
  }
}
